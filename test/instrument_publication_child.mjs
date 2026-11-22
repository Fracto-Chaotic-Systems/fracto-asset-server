import fs from "node:fs";
import { InstrumentTransferStore } from "../instruments/transfer_store.js";
import { transfer_hash } from "@fracto/sdk/utils/InstrumentTransfer.js";

const [root, packet_path, crash_phase] = process.argv.slice(2);
const packet = JSON.parse(fs.readFileSync(packet_path, "utf8"));
const owner = transfer_hash("publication-owner");
const store = new InstrumentTransferStore({
  directory: root,
  persistent: true,
  storage: async () => ({ ready: true, free_bytes: 32 * 1024 ** 3 }),
  publication: {
    hook: async (phase, entry) => {
      if (phase === crash_phase) {
        fs.writeSync(1, JSON.stringify({ session_id: entry.id }) + "\n");
        process.exit(47);
      }
    },
  },
});
await store.initialize();
const entry = store.start_session(
  owner,
  packet.manifest,
  packet.catalog_text,
  packet.replacement_policy,
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
store.finish_staging(entry, identity);
await entry.work;
store.finalize(entry, identity);
await entry.work;
process.exitCode = 2; // Expected crash hook was not reached.
