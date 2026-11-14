// Explicit disposable-container probe; never used by the application or test discovery.
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { publication_fixture } from "./instrument_transfer_fixture.js";
import { build_transfer_package } from "../instruments/transfer_package.js";
import { InstrumentTransferStore } from "../instruments/transfer_store.js";
import { verify_library } from "../instruments/library.js";
import { transfer_hash } from "../../../utils/instrument_transfer.js";

if (
  process.platform !== "linux" ||
  !["install", "verify"].includes(process.argv.at(-1))
)
  throw new Error("Run this probe only in its disposable Linux container");
const root = "/data",
  owner = transfer_hash("persistence-probe");
if (process.getuid() === 0) {
  await fs.chown(root, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}
assert.equal(process.getuid(), 1000);
const store = new InstrumentTransferStore({
  directory: root,
  persistent: true,
});
await store.initialize();
if (process.argv.at(-1) === "install") {
  const cleanup = [],
    source = publication_fixture({ after: (fn) => cleanup.push(fn) });
  try {
    const packet = await build_transfer_package(source.root);
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
    for (const file of packet.manifest.files)
      await store.receive(
        entry,
        file.file_id,
        Readable.from([
          await fs.readFile(`${source.root}/${file.relative_path}`),
        ]),
        file.bytes,
      );
    store.finish_staging(entry, identity);
    await entry.work;
    store.finalize(entry, identity);
    await entry.work;
    assert.equal(entry.state, "completed", JSON.stringify(entry.error));
    await fs.writeFile(
      `${root}/probe-receipt.json`,
      JSON.stringify({ id: entry.id, receipt: entry.receipt }),
    );
  } finally {
    for (const fn of cleanup) fn();
  }
} else {
  const proof = JSON.parse(
    await fs.readFile(`${root}/probe-receipt.json`, "utf8"),
  );
  const entry = await store.lookup(store.sessions, proof.id, owner);
  assert.equal(store.status(entry).state, "completed");
  assert.deepEqual(store.status(entry).receipt, proof.receipt);
  verify_library(root);
}
console.log(
  JSON.stringify({
    action: process.argv.at(-1),
    uid: process.getuid(),
    result: "passed",
  }),
);
