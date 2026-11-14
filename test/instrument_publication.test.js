import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publication_fixture } from "./instrument_transfer_fixture.js";
import { build_transfer_package } from "../instruments/transfer_package.js";
import { InstrumentTransferStore } from "../instruments/transfer_store.js";
import { initialize_instrument_storage } from "../instruments/transfer_storage_init.js";
import { verify_library } from "../instruments/library.js";
import { create_instrument_library } from "../instruments/http-library.js";
import { transfer_hash } from "../../../utils/instrument_transfer.js";
import { SUPPORT_FILES } from "../instruments/transfer_package.js";
import { prepared_kit } from "./drum_assets_fixture.js";

const owner = transfer_hash("publication-owner");
const storage = async () => ({ ready: true, free_bytes: 32 * 1024 ** 3 });
export async function staged_publication(
  t,
  {
    empty = false,
    invalid_pcm = false,
    publication = {},
    make_fixture = publication_fixture,
  } = {},
) {
  const source = make_fixture(t),
    target = make_fixture(t);
  if (invalid_pcm)
    for (const fixture of [source, target]) {
      const content = fs.readFileSync(
        path.join(fixture.root, fixture.asset.path),
      );
      content.fill(0, 44);
      Object.assign(fixture.asset, {
        sha256: transfer_hash(content),
        path: `playback/${fixture.recording.id}/${transfer_hash(content)}.wav`,
      });
      fixture.write(fixture.asset.path, content);
      fixture.save();
    }
  if (!invalid_pcm) verify_library(source.root);
  const packet = await build_transfer_package(source.root);
  for (const file of packet.manifest.files)
    if (empty || file.kind === "playback" || file.kind === "index")
      fs.unlinkSync(path.join(target.root, file.relative_path));
  target.write("destination-only.txt", "retain this file");
  const store = new InstrumentTransferStore({
    directory: target.root,
    persistent: true,
    storage,
    publication,
  });
  await store.initialize();
  const entry = store.start_session(
    owner,
    packet.manifest,
    packet.catalog_text,
  );
  await entry.work;
  const identity = {
    protocol_version: 1,
    manifest_sha256: entry.manifest_sha256,
    plan_sha256: "a".repeat(64),
  };
  store.prepare(entry, {
    ...identity,
    target_snapshot_sha256: entry.target_snapshot_sha256,
  });
  await entry.work;
  assert.equal(entry.state, "transferring", JSON.stringify(entry.error));
  for (const file of packet.manifest.files.filter(
    (file, index) => entry.observations[index].state === "missing",
  ))
    await store.receive(
      entry,
      file.file_id,
      Readable.from([
        fs.readFileSync(path.join(source.root, file.relative_path)),
      ]),
      file.bytes,
    );
  store.finish_staging(entry, identity);
  await entry.work;
  assert.equal(entry.state, "staged", JSON.stringify(entry.error));
  return { source, target, packet, store, entry, identity };
}
test("validated publication repairs identical catalogs, preserves backup and issues a durable receipt", async (t) => {
  const f = await staged_publication(t),
    original = fs.readFileSync(path.join(f.target.root, "catalog.json"));
  const library = create_instrument_library(f.target.root);
  await assert.rejects(library.load()); // Missing indexes before publication.
  const index = f.packet.manifest.files.find((file) => file.kind === "index");
  f.target.write(
    index.relative_path,
    fs.readFileSync(path.join(f.source.root, index.relative_path)),
  );
  const cached_snapshot = await library.load();
  assert.equal(await library.load(), cached_snapshot);
  fs.unlinkSync(path.join(f.target.root, index.relative_path));
  f.store.finalize(f.entry, f.identity);
  await f.entry.work;
  assert.equal(f.entry.state, "completed", JSON.stringify(f.entry.error));
  assert.deepEqual(
    fs.readFileSync(path.join(f.target.root, "catalog.json")),
    original,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        f.target.root,
        `.instrument-transfer/backups/${transfer_hash(original)}.json`,
      ),
    ),
    original,
  );
  verify_library(f.target.root);
  const snapshot = await library.load();
  assert.notEqual(snapshot, cached_snapshot); // Same catalog mtime, explicit generation invalidation.
  assert.equal(snapshot.revision, f.packet.manifest.catalog_sha256);
  for (const asset of snapshot.assets.values())
    assert.ok(await library.locate(asset));
  assert.equal(f.entry.receipt.files_verified, f.packet.manifest.files.length);
  assert.equal(
    fs.readFileSync(path.join(f.target.root, "destination-only.txt"), "utf8"),
    "retain this file",
  );
  const restarted = new InstrumentTransferStore({
    directory: f.target.root,
    persistent: true,
    storage,
  });
  await restarted.initialize();
  const restored = await restarted.lookup(
    restarted.sessions,
    f.entry.id,
    owner,
  );
  assert.deepEqual(restarted.status(restored).receipt, f.entry.receipt);
  assert.equal(restarted.finalize(restored, f.identity).state, "completed");
  await assert.rejects(
    restarted.lookup(restarted.sessions, f.entry.id, "b".repeat(64)),
    { status: 404 },
  );
});
test("empty destination publishes the catalog only after its dependencies validate and install", async (t) => {
  const observations = [];
  const f = await staged_publication(t, {
    empty: true,
    publication: {
      hook: async (phase, entry) => {
        if (phase === "dependency_installed" || phase === "catalog_intent") {
          observations.push(phase);
          assert.equal(
            fs.existsSync(path.join(f.target.root, "catalog.json")),
            false,
          );
        }
      },
    },
  });
  f.store.finalize(f.entry, f.identity);
  await f.entry.work;
  assert.equal(f.entry.state, "completed", JSON.stringify(f.entry.error));
  assert.ok(observations.includes("catalog_intent"));
  assert.equal(f.entry.summary.publication_state, "published");
  verify_library(f.target.root);
});
test("matching checksums alone cannot publish invalid PCM/index metadata", async (t) => {
  const f = await staged_publication(t, { invalid_pcm: true });
  assert.throws(() => verify_library(f.source.root));
  f.store.finalize(f.entry, f.identity);
  await f.entry.work;
  assert.equal(f.entry.state, "partial");
  assert.equal(f.entry.receipt, null);
  assert.equal(f.entry.error.code, "instrument_transfer_validation_failed");
  assert.equal(
    fs.existsSync(path.join(f.target.root, f.target.asset.path)),
    false,
  );
});
test("cancellation before catalog publication leaves the live catalog alone and releases the lock", async (t) => {
  let entered, release;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await staged_publication(t, {
    empty: true,
    publication: {
      hook: async (phase) => {
        if (phase === "candidate_validated") {
          entered();
          await gate;
        }
      },
    },
  });
  f.store.finalize(f.entry, f.identity);
  await waiting;
  const cancel = f.store.cancel(f.store.sessions, f.entry.id, owner);
  release();
  await cancel;
  assert.notEqual(f.entry.state, "completed");
  assert.equal(fs.existsSync(path.join(f.target.root, "catalog.json")), false);
  assert.equal(f.store.reservation, null);
});

test("cancellation during the catalog commit waits for verification instead of rolling back", async (t) => {
  let notify, release;
  const entered = new Promise((resolve) => {
    notify = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await staged_publication(t, {
    empty: true,
    publication: {
      hook: async (phase) => {
        if (phase === "catalog_intent") {
          notify();
          await gate;
        }
      },
    },
  });
  f.store.finalize(f.entry, f.identity);
  await entered;
  const response = await f.store.cancel(f.store.sessions, f.entry.id, owner);
  assert.equal(response.state, "publishing");
  assert.equal(response.signal.aborted, false);
  release();
  await f.entry.work;
  assert.equal(f.entry.state, "completed", JSON.stringify(f.entry.error));
});

test("process crashes before/after catalog commit recover from the durable journal", async (t) => {
  for (const phase of [
    "dependency_installed",
    "catalog_intent",
    "catalog_committed",
  ]) {
    const f = await staged_publication(t, { empty: true });
    const packet_path = path.join(
      f.source.root,
      "publication-test-packet.json",
    );
    fs.writeFileSync(packet_path, JSON.stringify(f.packet));
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./instrument_publication_child.mjs", import.meta.url),
          ),
          f.target.root,
          packet_path,
          phase,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(outcome.code, 47, outcome.stderr);
    const id = JSON.parse(outcome.stdout.trim()).session_id;
    await initialize_instrument_storage({
      directory: f.target.root,
      source: f.source.root,
      persistent: true,
    });
    const restarted = new InstrumentTransferStore({
      directory: f.target.root,
      persistent: true,
      storage,
    });
    await restarted.initialize();
    const active = restarted.sessions.get(id);
    if (active?.work) await active.work;
    const recovered = await restarted.lookup(restarted.sessions, id, owner),
      status = restarted.status(recovered);
    assert.equal(
      status.state,
      phase === "catalog_committed" ? "completed" : "partial",
      JSON.stringify(status.error),
    );
    assert.equal(
      fs.existsSync(path.join(f.target.root, "catalog.json")),
      phase === "catalog_committed",
    );
    if (phase === "catalog_committed") {
      assert.equal(status.receipt.manifest_sha256, f.entry.manifest_sha256);
      verify_library(f.target.root);
    } else {
      assert.equal(status.receipt, null);
      const retry = restarted.start_session(
        owner,
        f.packet.manifest,
        f.packet.catalog_text,
      );
      await retry.work;
      assert.equal(retry.summary.missing_files, 0); // Installed or verified-cached bytes are reusable.
    }
    assert.equal(restarted.reservation, null);
  }
});

test("persistent storage bootstraps data without copying code and preserves the installed catalog on later starts", async (t) => {
  const source = publication_fixture(t),
    target = publication_fixture(t);
  const packet = await build_transfer_package(target.root);
  for (const file of packet.manifest.files)
    fs.unlinkSync(path.join(target.root, file.relative_path));
  source.write("do-not-copy.js", "throw new Error('not instrument data')");
  await initialize_instrument_storage({
    directory: target.root,
    source: source.root,
    persistent: true,
  });
  verify_library(target.root);
  assert.equal(fs.existsSync(path.join(target.root, "do-not-copy.js")), false);
  const before = fs.readFileSync(path.join(target.root, "catalog.json"));
  source.catalog.library_version++;
  source.save();
  await initialize_instrument_storage({
    directory: target.root,
    source: source.root,
    persistent: true,
  });
  assert.deepEqual(
    fs.readFileSync(path.join(target.root, "catalog.json")),
    before,
  );
});

test("publication includes verified drum hit windows, render manifests and source notices", async (t) => {
  const make_fixture = (t) => {
    const fixture = publication_fixture(t);
    fixture.catalog.libraries = [
      {
        id: "legacy",
        name: "Legacy",
        version: "1",
        source_format: "chromatic-mp3",
        status: "active",
        percussion_library_id: "fluidr3-percussion",
      },
      {
        id: "fluidr3-percussion",
        name: "Percussion",
        version: "1",
        source_format: "sf2",
        status: "active",
      },
    ];
    Object.assign(fixture.catalog.instruments[0], {
      library_id: "legacy",
      instrument_key: "piano",
    });
    const prepared = prepared_kit({
      id: "fluidr3-percussion-kit-standard",
      library_id: "fluidr3-percussion",
      kit_key: "standard",
      kind: "drum-kit",
      name: "Standard",
      midi_program: 0,
      midi_bank: { msb: 0, lsb: 0 },
      source_preset: { bank: 128, program: 0 },
      source_sha256: "b".repeat(64),
      enabled: false,
      coverage_status: "source-audited",
      playback_mode: "one-shot",
      notes: [35, 42, 44, 46].map((midi_note) => ({
        midi_note,
        velocity_ranges: [[1, 127]],
      })),
      choke_groups: [{ source_exclusive_class: 1, midi_notes: [42, 44, 46] }],
      recordings: [],
      playback_assets: [],
    });
    prepared.kit.enabled = true;
    prepared.kit.verification_status = "playback_verified";
    fixture.catalog.drum_kits = [prepared.kit];
    fixture.catalog.percussion_preparation = prepared.totals;
    fixture.write(prepared.kit.playback_assets[0].path, prepared.content);
    fixture.write(
      prepared.kit.rendering.manifest_path,
      prepared.manifest_bytes,
    );
    for (const relative of SUPPORT_FILES["fluidr3-percussion"])
      fixture.write(
        `fluidr3-percussion/${relative}`,
        "fixture source notice\n",
      );
    fixture.save();
    return fixture;
  };
  const f = await staged_publication(t, { empty: true, make_fixture });
  f.store.finalize(f.entry, f.identity);
  await f.entry.work;
  assert.equal(f.entry.state, "completed", JSON.stringify(f.entry.error));
  const verified = verify_library(f.target.root);
  assert.equal(verified.drum_playback_assets_verified, true);
  assert.equal(verified.drum_hit_windows, 4);
  assert.equal(
    fs.readFileSync(
      path.join(f.target.root, "fluidr3-percussion/upstream/COPYING"),
      "utf8",
    ),
    "fixture source notice\n",
  );
});
