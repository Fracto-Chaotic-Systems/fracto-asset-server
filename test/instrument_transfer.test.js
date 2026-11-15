import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  transfer_fixture,
  add_transfer_index,
} from "./instrument_transfer_fixture.js";
import { InstrumentPreviewStore } from "../instruments/transfer_preview.js";
import {
  build_transfer_package,
  validate_package,
  package_dependencies,
} from "../instruments/transfer_package.js";
import {
  canonical_manifest,
  json_hash,
  transfer_hash,
} from "../../../utils/instrument_transfer.js";

const owner = transfer_hash("test-owner");

test("transfer-owned notice keeps identical bytes in Windows and Linux Git checkouts", (t) => {
  const available = spawnSync("git", ["--version"], { windowsHide: true });
  if (available.error?.code === "ENOENT")
    return t.skip("Git is absent from the runtime image");
  assert.equal(available.status, 0);
  const f = transfer_fixture(t);
  const repository = path.join(f.root, "repository");
  const relative = "instruments/fluidr3-percussion/README.md";
  const bytes = Buffer.from(
    "# Synthetic transfer notice\n\nIdentical text on both hosts.\n",
  );
  f.write(`repository/${relative}`, bytes);
  f.write(
    "repository/.gitattributes",
    fs.readFileSync(new URL("../.gitattributes", import.meta.url)),
  );
  const git = (...args) => {
    const result = spawnSync(
      "git",
      ["-c", "core.safecrlf=false", "-C", repository, ...args],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet");
  git("add", "--", ".gitattributes", relative);
  for (const automatic of ["true", "false"]) {
    git(
      "-c",
      `core.autocrlf=${automatic}`,
      "checkout-index",
      "--all",
      "--force",
    );
    assert.deepEqual(fs.readFileSync(path.join(repository, relative)), bytes);
  }
});
const storage = async () => ({ ready: true, free_bytes: 32 * 1024 ** 3 });
const store = (root, options = {}) =>
  new InstrumentPreviewStore({
    directory: root,
    persistent: true,
    storage,
    ...options,
  });
async function scan(t, modify = () => {}, options = {}) {
  const source = transfer_fixture(t),
    receiver = transfer_fixture(t);
  modify(receiver);
  const packet = await build_transfer_package(source.root);
  const target = store(receiver.root, options);
  const entry = target.start_session(
    owner,
    packet.manifest,
    packet.catalog_text,
  );
  await entry.work;
  return { source, receiver, packet, target, entry };
}
test("inventory hashes disabled instruments, is canonical, and does not include unreferenced files", async (t) => {
  const source = transfer_fixture(t);
  source.write("unrelated-secret", "not exported");
  const packet = await build_transfer_package(source.root);
  assert.equal(packet.manifest.files.length, 3);
  assert.deepEqual(
    packet.manifest.files.map((f) => f.kind),
    ["catalog", "original", "playback"],
  );
  assert.equal(
    json_hash(
      canonical_manifest({
        ...packet.manifest,
        files: [...packet.manifest.files].reverse(),
      }),
    ),
    json_hash(packet.manifest),
  );
  assert.equal(
    packet.manifest.catalog_sha256,
    transfer_hash(fs.readFileSync(path.join(source.root, "catalog.json"))),
  );
});
test("matching bytes produce a zero-copy preview without writing to either store", async (t) => {
  const { receiver, entry, target } = await scan(t);
  assert.equal(entry.state, "ready");
  assert.equal(entry.summary.missing_files, 0);
  assert.equal(entry.summary.matching_files, 3);
  assert.equal(target.status(entry).progress.bytes_transferred, 0);
  assert.equal(
    fs.existsSync(path.join(receiver.root, ".instrument-transfer")),
    false,
  );
});
test("empty and same-catalog incomplete receiver inventories work without loading the receiver runtime catalog", async (t) => {
  for (const empty of [false, true]) {
    const { entry, receiver } = await scan(t, (r) => {
      fs.unlinkSync(path.join(r.root, r.asset.path));
      if (empty) {
        fs.unlinkSync(path.join(r.root, "catalog.json"));
        fs.unlinkSync(path.join(r.root, r.recording.path));
      }
    });
    assert.equal(entry.state, "ready");
    assert.equal(entry.summary.missing_files, empty ? 3 : 1);
    assert.equal(
      entry.summary.target_catalog_sha256,
      empty ? null : entry.summary.source_catalog_sha256,
    );
    assert.equal(
      fs.existsSync(path.join(receiver.root, receiver.asset.path)),
      false,
    );
  }
});
test("same-sized corrupt bytes and different catalogs block instead of overwriting", async (t) => {
  const corrupted = await scan(t, (r) =>
    r.write(r.asset.path, Buffer.alloc(64, 1)),
  );
  assert.equal(corrupted.entry.state, "blocked");
  assert.equal(corrupted.entry.error.code, "instrument_transfer_file_conflict");
  assert.equal(corrupted.entry.summary.conflict_files, 1);
  assert.equal(
    fs.readFileSync(
      path.join(corrupted.receiver.root, corrupted.receiver.asset.path),
    )[0],
    1,
  );
  const changed = await scan(t, (r) => {
    r.catalog.library_version++;
    r.save();
  });
  assert.equal(
    changed.entry.error.code,
    "instrument_transfer_catalog_conflict",
  );
});
test("source missing or tampered data cannot become a ready export", async (t) => {
  for (const missing of [true, false]) {
    const f = transfer_fixture(t);
    if (missing) fs.unlinkSync(path.join(f.root, f.recording.path));
    else f.write(f.recording.path, "same catalog different bytes");
    await assert.rejects(build_transfer_package(f.root), {
      code: "instrument_transfer_source_incomplete",
    });
  }
});
test("manifest dependency closure rejects traversal, extras, omissions, case aliases, sizes and hash mismatches", async (t) => {
  const f = transfer_fixture(t);
  const packet = await build_transfer_package(f.root);
  const mutations = [
    (m) => m.files.pop(),
    (m) => {
      m.files[1].relative_path = "../escape";
    },
    (m) => {
      m.files[1].sha256 = "a".repeat(64);
    },
    (m) => {
      m.files[1].bytes++;
    },
    (m) =>
      m.files.push({
        ...m.files[1],
        relative_path: "private.txt",
        file_id: transfer_hash("private.txt"),
      }),
    (m) =>
      m.files.push({
        ...m.files[1],
        relative_path: "ORIGINALS/PIANO.mp3",
        file_id: transfer_hash("ORIGINALS/PIANO.mp3"),
      }),
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(packet.manifest);
    mutate(manifest);
    assert.throws(() => validate_package(manifest, packet.catalog_text));
  }
  assert.throws(() =>
    validate_package(packet.manifest, packet.catalog_text + " "),
  );
});
test("space, persistent-storage readiness and receiver ownership gate preview", async (t) => {
  const disk = await scan(t, () => {}, {
    storage: async () => ({ ready: true, free_bytes: 1 }),
  });
  assert.equal(disk.entry.error.code, "instrument_transfer_insufficient_space");
  const ephemeral = await scan(t, () => {}, {
    storage: async () => ({ ready: false, free_bytes: 32 * 1024 ** 3 }),
  });
  assert.equal(
    ephemeral.entry.error.code,
    "instrument_transfer_storage_not_ready",
  );
  assert.throws(
    () =>
      ephemeral.target.get(
        ephemeral.target.sessions,
        ephemeral.entry.id,
        "other",
      ),
    { status: 404 },
  );
});
test("cancellation and expiry cannot publish a ready preview", async (t) => {
  const f = transfer_fixture(t),
    packet = await build_transfer_package(f.root);
  let now = 0;
  const target = store(f.root, { now: () => now });
  const entry = target.start_session(
    owner,
    packet.manifest,
    packet.catalog_text,
  );
  target.cancel(target.sessions, entry.id, owner);
  await entry.work;
  assert.equal(entry.state, "cancelled");
  now = 1800001;
  assert.throws(() => target.get(target.sessions, entry.id, owner), {
    status: 410,
  });
});
test("symlink and junction dependencies cannot escape a receiver store", async (t) => {
  const f = transfer_fixture(t),
    other = transfer_fixture(t);
  const packet = await build_transfer_package(f.root);
  fs.unlinkSync(path.join(f.root, f.asset.path));
  fs.rmdirSync(path.dirname(path.join(f.root, f.asset.path)));
  try {
    fs.symlinkSync(
      path.dirname(path.join(other.root, other.asset.path)),
      path.dirname(path.join(f.root, f.asset.path)),
      "junction",
    );
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("OS denies creating test junction");
      return;
    }
    throw error;
  }
  const target = store(f.root);
  const entry = target.start_session(
    owner,
    packet.manifest,
    packet.catalog_text,
  );
  await entry.work;
  assert.equal(entry.state, "failed");
  assert.equal(entry.error.code, "instrument_transfer_invalid_path");
});
test("real catalog dependency closure includes all melodic/drum assets and supplied notices", () => {
  const text = fs.readFileSync(
    new URL("../instruments/catalog.json", import.meta.url),
    "utf8",
  );
  const { catalog, files } = package_dependencies(text);
  assert.equal(
    [...files.values()].filter((f) => f.kind === "playback").length,
    new Set(
      [
        ...catalog.instruments.flatMap((i) => i.playback_assets),
        ...catalog.drum_kits.flatMap((k) => k.playback_assets),
      ].map((a) => a.path),
    ).size,
  );
  assert.ok(files.has("fluidr3-gm/upstream/LICENSE.txt"));
  assert.ok(files.has("fluidr3-percussion/upstream/COPYING"));
});

test("a missing receiver index can be previewed while an incomplete source index blocks export", async (t) => {
  const source = transfer_fixture(t),
    receiver = transfer_fixture(t);
  const relative = add_transfer_index(source);
  add_transfer_index(receiver);
  fs.unlinkSync(path.join(receiver.root, relative));
  const packet = await build_transfer_package(source.root);
  const target = store(receiver.root);
  const entry = target.start_session(
    owner,
    packet.manifest,
    packet.catalog_text,
  );
  await entry.work;
  assert.equal(entry.state, "ready");
  assert.equal(entry.summary.missing_files, 1);
  fs.unlinkSync(path.join(source.root, relative));
  await assert.rejects(build_transfer_package(source.root), {
    code: "instrument_transfer_source_incomplete",
  });
});

test("repeated previews keep the newest three instead of blocking until expiry", async (t) => {
  const f = transfer_fixture(t),
    packet = await build_transfer_package(f.root);
  const target = store(f.root);
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const entry = target.start_session(
      owner,
      packet.manifest,
      packet.catalog_text,
    );
    ids.push(entry.id);
    await entry.work;
    assert.equal(entry.state, "ready");
  }
  assert.equal(target.sessions.size, 3);
  assert.throws(() => target.get(target.sessions, ids[0], owner), {
    status: 404,
  });
});
