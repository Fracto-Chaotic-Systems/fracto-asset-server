import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { transfer_fixture } from "./instrument_transfer_fixture.js";
import { InstrumentTransferStore } from "../instruments/transfer_store.js";
import { build_transfer_package } from "../instruments/transfer_package.js";
import {
  observe_staged,
  source_file_chunks,
} from "../instruments/transfer_staging.js";
import { transfer_hash } from "../../../utils/instrument_transfer.js";
import { transfer_deadline } from "../../../utils/instrument_transfer_stream.js";

const owner = transfer_hash("stream-owner");
const space = async () => ({ ready: true, free_bytes: 32 * 1024 ** 3 });
async function prepared(t, { empty = false } = {}) {
  const source = transfer_fixture(t),
    target = transfer_fixture(t);
  const packet = await build_transfer_package(source.root);
  fs.unlinkSync(path.join(target.root, target.asset.path));
  if (empty) {
    fs.unlinkSync(path.join(target.root, "catalog.json"));
    fs.unlinkSync(path.join(target.root, target.recording.path));
  }
  const store = new InstrumentTransferStore({
    directory: target.root,
    persistent: true,
    storage: space,
  });
  const entry = store.start_session(
    owner,
    packet.manifest,
    packet.catalog_text,
  );
  await entry.work;
  const plan = {
    protocol_version: 1,
    manifest_sha256: entry.manifest_sha256,
    target_snapshot_sha256: entry.target_snapshot_sha256,
    plan_sha256: "a".repeat(64),
  };
  store.prepare(entry, plan);
  await entry.work;
  assert.equal(entry.state, "transferring");
  const file = packet.manifest.files.find((file) => file.kind === "playback");
  return { source, target, packet, store, entry, plan, file };
}
function bytes(f, file = f.file) {
  return fs.readFileSync(path.join(f.source.root, file.relative_path));
}
function leftovers(root) {
  return fs
    .readdirSync(root, { recursive: true })
    .filter((name) => String(name).endsWith(".part"));
}

test("receiver rejects truncated/corrupt uploads and retries without publishing or overwriting", async (t) => {
  const f = await prepared(t);
  try {
    for (const content of [bytes(f).subarray(0, 63), Buffer.alloc(64, 1)]) {
      await assert.rejects(
        f.store.receive(
          f.entry,
          f.file.file_id,
          Readable.from([content]),
          f.file.bytes,
        ),
        { code: "instrument_transfer_checksum_mismatch" },
      );
      assert.equal(
        await observe_staged(f.target.root, f.entry.manifest_sha256, f.file),
        null,
      );
      assert.deepEqual(leftovers(f.target.root), []);
    }
    const ack = await f.store.receive(
      f.entry,
      f.file.file_id,
      Readable.from([bytes(f)]),
      f.file.bytes,
    );
    assert.equal(ack.disposition, "staged");
    const retry = await f.store.receive(
      f.entry,
      f.file.file_id,
      Readable.from([bytes(f)]),
      f.file.bytes,
    );
    assert.equal(retry.disposition, "already_present");
    assert.equal(f.store.status(f.entry).progress.bytes_transferred, 64);
    assert.equal(
      fs.existsSync(path.join(f.target.root, f.target.asset.path)),
      false,
    );
  } finally {
    await f.store.cancel(f.store.sessions, f.entry.id, owner);
  }
});

test("cancelling a blocked incoming stream settles I/O and removes its partial file", async (t) => {
  const f = await prepared(t);
  const input = new Readable({ read() {} });
  const incoming = f.store.receive(
    f.entry,
    f.file.file_id,
    input,
    f.file.bytes,
  );
  const rejected = assert.rejects(incoming);
  input.push(bytes(f).subarray(0, 10));
  // Wait for the partial file to be created, so cancellation actually interrupts a write.
  while (
    !fs.existsSync(path.join(f.target.root, ".instrument-transfer")) ||
    !leftovers(f.target.root).length
  )
    await new Promise((resolve) => setImmediate(resolve));
  await f.store.cancel(f.store.sessions, f.entry.id, owner);
  await rejected;
  assert.deepEqual(leftovers(f.target.root), []);
  assert.equal(f.store.reservation, null);
});

test("duplicate and unknown uploads are rejected while a file is active", async (t) => {
  const f = await prepared(t);
  const input = new Readable({ read() {} });
  const first = f.store.receive(f.entry, f.file.file_id, input, f.file.bytes);
  const rejected = assert.rejects(first);
  await assert.rejects(
    f.store.receive(f.entry, f.file.file_id, Readable.from([]), f.file.bytes),
    { code: "instrument_transfer_busy" },
  );
  await assert.rejects(
    f.store.receive(f.entry, "b".repeat(64), Readable.from([]), 64),
    { status: 404 },
  );
  await f.store.cancel(f.store.sessions, f.entry.id, owner);
  await rejected;
});

test("verified staging survives store restart, including a staged catalog for an empty receiver", async (t) => {
  const f = await prepared(t, { empty: true });
  for (const file of f.packet.manifest.files)
    await f.store.receive(
      f.entry,
      file.file_id,
      Readable.from([bytes(f, file)]),
      file.bytes,
    );
  f.store.finish_staging(f.entry, {
    protocol_version: 1,
    manifest_sha256: f.entry.manifest_sha256,
    plan_sha256: f.plan.plan_sha256,
  });
  await f.entry.work;
  assert.equal(f.entry.state, "staged");
  assert.equal(fs.existsSync(path.join(f.target.root, "catalog.json")), false);
  const restarted = new InstrumentTransferStore({
    directory: f.target.root,
    persistent: true,
    storage: space,
  });
  const preview = restarted.start_session(
    owner,
    f.packet.manifest,
    f.packet.catalog_text,
  );
  await preview.work;
  assert.equal(preview.state, "ready");
  assert.equal(preview.summary.missing_files, 0);
  assert.equal(preview.summary.target_catalog_sha256, null);
  assert.equal(restarted.status(preview).pending_bitmap, "AA==");
});

test("changed preview state and source mutations cannot be transferred", async (t) => {
  const f = transfer_fixture(t),
    packet = await build_transfer_package(f.root);
  const store = new InstrumentTransferStore({
    directory: f.root,
    persistent: true,
    storage: space,
  });
  const target = store.start_session(
    owner,
    packet.manifest,
    packet.catalog_text,
  );
  await target.work;
  fs.unlinkSync(path.join(f.root, f.asset.path));
  store.prepare(target, {
    protocol_version: 1,
    manifest_sha256: target.manifest_sha256,
    target_snapshot_sha256: target.target_snapshot_sha256,
    plan_sha256: "a".repeat(64),
  });
  await target.work;
  assert.equal(target.state, "failed");
  assert.equal(target.error.code, "instrument_transfer_snapshot_changed");
  assert.equal(store.reservation, null);
  f.write(f.asset.path, Buffer.alloc(64, 1));
  const file = packet.manifest.files.find((file) => file.kind === "playback");
  await assert.rejects(
    async () => {
      for await (const _ of source_file_chunks(f.root, file)) {
      }
    },
    { code: "instrument_transfer_snapshot_changed" },
  );
});

test("incoming disk exhaustion is checked before admitting a file", async (t) => {
  const f = await prepared(t);
  try {
    f.store.storage = async () => ({ ready: true, free_bytes: 1 });
    await assert.rejects(
      f.store.receive(f.entry, f.file.file_id, Readable.from([bytes(f)]), 64),
      { code: "instrument_transfer_insufficient_space" },
    );
    assert.equal(
      fs.existsSync(path.join(f.target.root, ".instrument-transfer/packages")),
      false,
    );
  } finally {
    await f.store.cancel(f.store.sessions, f.entry.id, owner);
  }
});

test("a staging junction cannot redirect received files outside the instrument root", async (t) => {
  const f = await prepared(t),
    outside = transfer_fixture(t);
  try {
    try {
      fs.symlinkSync(
        outside.root,
        path.join(f.target.root, ".instrument-transfer/packages"),
        "junction",
      );
    } catch (error) {
      if (error.code === "EPERM") {
        t.skip("junction creation denied by OS");
        return;
      }
      throw error;
    }
    await assert.rejects(
      f.store.receive(f.entry, f.file.file_id, Readable.from([bytes(f)]), 64),
      { code: "instrument_transfer_invalid_path" },
    );
    assert.equal(fs.existsSync(path.join(outside.root, "packages")), false);
  } finally {
    await f.store.cancel(f.store.sessions, f.entry.id, owner);
  }
});

test("idle transfer deadlines abort even when no more chunks arrive", async () => {
  const deadline = transfer_deadline(undefined, {
    idle_ms: 10,
    absolute_ms: 1000,
  });
  try {
    await new Promise((resolve) => {
      const keep_alive = setTimeout(() => resolve(), 100);
      deadline.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(keep_alive);
          resolve();
        },
        { once: true },
      );
    });
    assert.equal(deadline.signal.reason.code, "instrument_transfer_timeout");
  } finally {
    deadline.close();
  }
});

test("one store cannot send and receive at once, and only two uploads may be active", async (t) => {
  const f = await prepared(t, { empty: true });
  assert.throws(() => f.store.start_export(owner), {
    code: "instrument_transfer_busy",
  });
  const inputs = [new Readable({ read() {} }), new Readable({ read() {} })];
  const first = f.store.receive(
    f.entry,
    f.packet.manifest.files[0].file_id,
    inputs[0],
    f.packet.manifest.files[0].bytes,
  );
  const second = f.store.receive(
    f.entry,
    f.packet.manifest.files[1].file_id,
    inputs[1],
    f.packet.manifest.files[1].bytes,
  );
  const failures = [assert.rejects(first), assert.rejects(second)];
  await assert.rejects(
    f.store.receive(
      f.entry,
      f.packet.manifest.files[2].file_id,
      Readable.from([]),
      f.packet.manifest.files[2].bytes,
    ),
    { code: "instrument_transfer_busy" },
  );
  await f.store.cancel(f.store.sessions, f.entry.id, owner);
  await Promise.all(failures);
  assert.equal(f.store.reservation, null);
});

test("source reservation rejects a changed file before streaming any bytes", async (t) => {
  const f = transfer_fixture(t),
    store = new InstrumentTransferStore({ directory: f.root, storage: space });
  const entry = store.start_export(owner);
  await entry.work;
  f.write(f.asset.path, Buffer.alloc(64, 1));
  store.reserve_export(entry, {
    protocol_version: 1,
    manifest_sha256: entry.manifest_sha256,
  });
  await entry.work;
  assert.equal(entry.state, "failed");
  assert.equal(entry.error.code, "instrument_transfer_snapshot_changed");
  assert.equal(store.reservation, null);
});

test("a new conflicting live file cannot be overwritten after prepare", async (t) => {
  const f = await prepared(t);
  try {
    f.target.write(f.target.asset.path, Buffer.alloc(64, 1));
    await assert.rejects(
      f.store.receive(f.entry, f.file.file_id, Readable.from([bytes(f)]), 64),
      { code: "instrument_transfer_snapshot_changed" },
    );
    assert.deepEqual(
      fs.readFileSync(path.join(f.target.root, f.target.asset.path)),
      Buffer.alloc(64, 1),
    );
  } finally {
    await f.store.cancel(f.store.sessions, f.entry.id, owner);
  }
});
