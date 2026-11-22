import { InstrumentPreviewStore } from "./transfer_preview.js";
import { build_transfer_package } from "./transfer_package.js";
import { InstrumentPublication } from "./transfer_publication.js";
import {
  observe_staged,
  receive_staged_file,
  source_file_chunks,
} from "./transfer_staging.js";
import {
  TRANSFER_LIMITS,
  exact_fields,
  is_hash,
  json_hash,
  transfer_error,
  public_transfer_error,
} from "@fracto/sdk/utils/InstrumentTransfer.js";

// One owner lock covers outgoing and incoming operations on this store. Verified
// cache files survive sessions; the live catalog/assets are never written here.
export class InstrumentTransferStore extends InstrumentPreviewStore {
  constructor({
    publication_enabled = true,
    publication = {},
    ...options
  } = {}) {
    super(options);
    this.publication_enabled = publication_enabled;
    this.reservation = null;
    this.publisher = new InstrumentPublication(this, publication);
  }
  initialize() {
    return this.publisher.initialize();
  }
  start_session(
    owner,
    manifest,
    catalog_text,
    replacement_policy = "preserve",
  ) {
    if (!["preserve", "source"].includes(replacement_policy))
      throw transfer_error("invalid_request", 400);
    if (replacement_policy === "source" && !this.publication_enabled)
      throw transfer_error("upgrade_required");
    // Reserve room for the bounded status/ownership envelope in the commit WAL.
    if (
      this.publication_enabled &&
      Buffer.byteLength(
        JSON.stringify({ protocol_version: 1, manifest, catalog_text }),
      ) +
        TRANSFER_LIMITS.control_bytes >
        TRANSFER_LIMITS.preview_request_bytes
    )
      throw transfer_error("limit_exceeded", 413);
    return super.start_session(
      owner,
      manifest,
      catalog_text,
      replacement_policy,
    );
  }
  async lookup(map, id, owner) {
    if (map.has(id) || map !== this.sessions) return this.get(map, id, owner);
    return this.publisher.lookup(id, owner);
  }
  async capabilities() {
    return {
      ...(await super.capabilities()),
      preview_only: false,
      staging_supported: true,
      publication_supported: this.publication_enabled,
      replacement_policies: this.publication_enabled ? ["source"] : [],
    };
  }
  create(...args) {
    if (this.reservation) throw transfer_error("busy");
    const entry = super.create(...args);
    entry.inflight = new Map();
    entry.acknowledged = new Set();
    return entry;
  }
  get(map, id, owner) {
    const entry = super.get(map, id, owner);
    if (
      this.reservation === entry &&
      !entry.signal.aborted &&
      entry.state !== "completed"
    )
      this.touch(entry);
    return entry;
  }
  async observe_receiver(entry, file, signal, live = undefined) {
    if (live === undefined)
      live = await super.observe_receiver(entry, file, signal);
    if (live?.sha256 === file.sha256 && live.bytes === file.bytes) return live;
    if (live && entry.replacement_policy !== "source") return live;
    const staged = await observe_staged(
      this.directory,
      entry.manifest_sha256,
      file,
      signal,
    );
    return staged?.sha256 === file.sha256 && staged.bytes === file.bytes
      ? staged
      : live;
  }
  acquire(entry) {
    if (this.reservation && this.reservation !== entry)
      throw transfer_error("busy");
    this.reservation = entry;
    entry.controller = new AbortController();
    entry.end_at ??= this.now() + TRANSFER_LIMITS.apply_seconds * 1000;
    entry.signal = AbortSignal.any([
      entry.controller.signal,
      AbortSignal.timeout(Math.max(1, entry.end_at - this.now())),
    ]);
    this.touch(entry);
    entry.watchdog = setInterval(() => {
      if (entry.deadline <= this.now() || entry.signal.aborted)
        void this.stop(entry, transfer_error("expired", 410));
    }, 1000);
    entry.watchdog.unref?.();
  }
  touch(entry) {
    entry.deadline = Math.min(
      entry.end_at,
      this.now() + TRANSFER_LIMITS.session_idle_seconds * 1000,
    );
  }
  async unlock(entry) {
    clearInterval(entry.watchdog);
    await Promise.allSettled([...entry.inflight.values()]);
    if (this.reservation === entry) this.reservation = null;
  }
  async stop(entry, error = transfer_error("cancelled", 503)) {
    if (entry.critical) return;
    if (entry.finalizing) {
      entry.controller.abort(error);
      await entry.work;
      return;
    }
    entry.controller.abort(error);
    entry.state =
      entry.durable_changes || entry.acknowledged.size
        ? "partial"
        : "cancelled";
    entry.error = public_transfer_error(error);
    await this.unlock(entry);
  }
  run(entry, action) {
    entry.work = action().catch(async (error) => {
      entry.controller.abort(error);
      entry.state =
        entry.durable_changes || entry.acknowledged.size
          ? "partial"
          : entry.state === "cancelled"
            ? "cancelled"
            : "failed";
      entry.error = public_transfer_error(error);
      await this.unlock(entry);
    });
    return entry;
  }
  reserve_export(entry, body) {
    exact_fields(body, ["protocol_version", "manifest_sha256"]);
    if (
      body.protocol_version !== 1 ||
      body.manifest_sha256 !== entry.manifest_sha256
    )
      throw transfer_error("snapshot_changed");
    if (["reserving", "reserved"].includes(entry.state)) return entry;
    if (entry.state !== "ready") throw transfer_error("invalid_state");
    this.acquire(entry);
    entry.state = "reserving";
    return this.run(entry, async () => {
      let packet;
      try {
        packet = await build_transfer_package(this.directory, {
          signal: entry.signal,
          on_progress: () => this.touch(entry),
        });
      } catch (error) {
        if (error.code === "instrument_transfer_source_incomplete")
          throw transfer_error("snapshot_changed");
        throw error;
      }
      entry.signal.throwIfAborted();
      if (json_hash(packet.manifest) !== entry.manifest_sha256)
        throw transfer_error("snapshot_changed");
      entry.state = "reserved";
      this.touch(entry);
    });
  }
  prepare(entry, body) {
    exact_fields(body, [
      "protocol_version",
      "manifest_sha256",
      "target_snapshot_sha256",
      "plan_sha256",
    ]);
    if (
      body.protocol_version !== 1 ||
      body.manifest_sha256 !== entry.manifest_sha256 ||
      body.target_snapshot_sha256 !== entry.target_snapshot_sha256 ||
      !is_hash(body.plan_sha256)
    )
      throw transfer_error("snapshot_changed");
    if (["preparing", "transferring", "staged"].includes(entry.state)) {
      if (entry.plan_sha256 !== body.plan_sha256)
        throw transfer_error("snapshot_changed");
      return entry;
    }
    if (entry.state !== "ready") throw transfer_error("invalid_state");
    this.acquire(entry);
    entry.state = "preparing";
    entry.plan_sha256 = body.plan_sha256;
    const expected = entry.target_snapshot_sha256;
    return this.run(entry, async () => {
      entry.files_checked = 0;
      await this.scan_receiver(entry, entry.package.manifest);
      entry.signal.throwIfAborted();
      if (entry.target_snapshot_sha256 !== expected)
        throw transfer_error("snapshot_changed");
      if (entry.state !== "ready")
        throw transfer_error(
          entry.error?.code?.replace("instrument_transfer_", "") ||
            "invalid_state",
        );
      entry.state = "preparing";
      await this.publisher.save(entry, "prepared");
      entry.state = "transferring";
      this.touch(entry);
    });
  }
  file(entry, file_id) {
    const file = entry.package.manifest.files.find(
      (f) => f.file_id === file_id,
    );
    if (!file) throw transfer_error("file_not_found", 404);
    return file;
  }
  send(entry, file_id) {
    if (entry.state !== "reserved" || this.reservation !== entry)
      throw transfer_error("invalid_state");
    const file = this.file(entry, file_id);
    if (
      entry.inflight.has(file_id) ||
      entry.inflight.size >= TRANSFER_LIMITS.concurrent_files
    )
      throw transfer_error("busy");
    let done;
    entry.inflight.set(
      file_id,
      new Promise((resolve) => {
        done = resolve;
      }),
    );
    const chunks = source_file_chunks(this.directory, file, {
      signal: entry.signal,
      touch: () => this.touch(entry),
    });
    return {
      chunks,
      close: async () => {
        try {
          await chunks.return();
        } finally {
          entry.inflight.delete(file_id);
          done();
        }
      },
    };
  }
  async receive(entry, file_id, input, length) {
    if (entry.state !== "transferring" || this.reservation !== entry)
      throw transfer_error("invalid_state");
    const file = this.file(entry, file_id);
    if (
      !entry.observations.some(
        (observed) =>
          observed.file_id === file_id &&
          (observed.state === "missing" ||
            (entry.replacement_policy === "source" &&
              observed.state === "conflict")),
      )
    )
      throw transfer_error("invalid_state");
    if (file.bytes !== length) throw transfer_error("checksum_mismatch", 422);
    if (
      entry.inflight.has(file_id) ||
      entry.inflight.size >= TRANSFER_LIMITS.concurrent_files
    )
      throw transfer_error("busy");
    const work = (async () => {
      const storage = await this.storage(this.directory, this.persistent);
      if (!storage.ready) throw transfer_error("storage_not_ready", 503);
      // Count all unacknowledged planned bytes; concurrent writers cannot over-admit.
      const outstanding = entry.package.manifest.files.reduce(
        (n, f, index) =>
          n +
          (entry.observations[index].state !== "matching" &&
          !entry.acknowledged.has(f.file_id)
            ? f.bytes
            : 0),
        0,
      );
      if (storage.free_bytes < outstanding + file.bytes + 1024 ** 3)
        throw transfer_error("insufficient_space", 507);
      const live = await super.observe_receiver(entry, file, entry.signal);
      const expected = entry.live_observations.find(
        (o) => o.file_id === file_id,
      );
      if (
        (live?.sha256 ?? null) !== expected.sha256 ||
        (live?.bytes ?? null) !== expected.bytes
      )
        throw transfer_error("snapshot_changed");
      const result = await receive_staged_file(
        this.directory,
        entry.manifest_sha256,
        file,
        input,
        {
          signal: entry.signal,
          touch: () => this.touch(entry),
          on_commit: () => {
            entry.durable_changes = true;
          },
        },
      );
      entry.acknowledged.add(file_id);
      this.touch(entry);
      return result;
    })();
    entry.inflight.set(file_id, work);
    try {
      return await work;
    } finally {
      entry.inflight.delete(file_id);
    }
  }
  finish_staging(entry, body) {
    exact_fields(body, ["protocol_version", "manifest_sha256", "plan_sha256"]);
    if (
      body.protocol_version !== 1 ||
      body.manifest_sha256 !== entry.manifest_sha256 ||
      body.plan_sha256 !== entry.plan_sha256
    )
      throw transfer_error("snapshot_changed");
    if (["validating", "staged"].includes(entry.state)) return entry;
    if (entry.state !== "transferring" || entry.inflight.size)
      throw transfer_error("invalid_state");
    entry.state = "validating";
    return this.run(entry, async () => {
      for (const file of entry.package.manifest.files) {
        const observed = await this.observe_receiver(entry, file, entry.signal);
        if (observed?.sha256 !== file.sha256 || observed.bytes !== file.bytes)
          throw transfer_error("verification_failed", 503);
        this.touch(entry);
      }
      entry.signal.throwIfAborted();
      await this.publisher.save(entry, "staged");
      await this.unlock(entry);
      entry.state = "staged";
      entry.deadline = this.now() + TRANSFER_LIMITS.preview_seconds * 1000;
    });
  }
  finalize(entry, body) {
    exact_fields(body, ["protocol_version", "manifest_sha256", "plan_sha256"]);
    if (!this.publication_enabled) throw transfer_error("upgrade_required");
    const manifest_sha256 =
      entry.recovered_status?.manifest_sha256 ?? entry.manifest_sha256;
    if (
      body.protocol_version !== 1 ||
      body.manifest_sha256 !== manifest_sha256 ||
      body.plan_sha256 !== entry.plan_sha256
    )
      throw transfer_error("snapshot_changed");
    if (entry.state === "completed" || entry.finalizing) return entry;
    if (entry.state !== "staged") throw transfer_error("invalid_state");
    this.acquire(entry);
    entry.state = "validating";
    entry.finalizing = true;
    entry.work = this.publisher.transaction(entry, () =>
      this.publisher.publish(entry),
    );
    return entry;
  }
  status(entry, exporting = false) {
    if (entry.recovered_status) return structuredClone(entry.recovered_status);
    const status = super.status(entry, exporting);
    if (!exporting) {
      const transferred = entry.package.manifest.files.filter((file) =>
        entry.acknowledged.has(file.file_id),
      );
      status.progress.bytes_transferred = transferred.reduce(
        (sum, file) => sum + file.bytes,
        0,
      );
      status.progress.files_verified = ["staged", "completed"].includes(
        entry.state,
      )
        ? entry.files_total
        : (entry.summary?.matching_files ?? 0) +
          transferred.filter(
            (file) =>
              entry.observations?.find((o) => o.file_id === file.file_id)
                ?.state !== "matching",
          ).length;
      const pending = Buffer.alloc(Math.ceil(entry.files_total / 8));
      entry.observations?.forEach((file, index) => {
        if (file.state !== "matching") pending[index >> 3] |= 1 << (index & 7);
      });
      status.pending_bitmap = pending.toString("base64");
      status.receipt = entry.receipt ?? null;
    }
    return status;
  }
  async cancel(map, id, owner) {
    const entry = await this.lookup(map, id, owner);
    if (
      entry.finalizing &&
      ["partial", "failed", "completed"].includes(entry.state)
    ) {
      await entry.work;
      return entry;
    }
    if (
      ["staged", "completed", "partial", "failed", "cancelled"].includes(
        entry.state,
      ) ||
      entry.critical
    )
      return entry;
    await this.stop(entry);
    await entry.work;
    return entry;
  }
}
