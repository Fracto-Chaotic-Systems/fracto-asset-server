import { randomUUID } from "node:crypto";
import {
  build_transfer_package,
  validate_package,
  INDEX_METHODS,
  AUDIO_METHODS,
  SUPPORT_FILES,
} from "./transfer_package.js";
import { observe_transfer_file, transfer_storage } from "./transfer_files.js";
import { MAX_CATALOG_BYTES } from "./catalog-libraries.js";
import {
  TRANSFER_LIMITS,
  json_hash,
  transfer_error,
  public_transfer_error,
} from "../../../utils/instrument_transfer.js";

export class InstrumentPreviewStore {
  constructor({
    directory,
    persistent = false,
    now = Date.now,
    storage = transfer_storage,
  } = {}) {
    this.directory = directory;
    this.persistent = persistent;
    this.now = now;
    this.storage = storage;
    this.exports = new Map();
    this.sessions = new Map();
  }
  async capabilities() {
    const storage = await this.storage(this.directory, this.persistent);
    return {
      protocol_versions: [1],
      catalog_schema_versions: [1],
      index_methods: INDEX_METHODS,
      audio_methods: AUDIO_METHODS,
      support_libraries: Object.keys(SUPPORT_FILES),
      receive_ready: storage.ready,
      error: storage.ready
        ? null
        : public_transfer_error(transfer_error("storage_not_ready", 503)),
      limits: TRANSFER_LIMITS,
      preview_only: true,
    };
  }
  prune(map) {
    for (const [id, entry] of map) {
      if (entry.deadline <= this.now()) {
        entry.controller.abort();
        map.delete(id);
      }
    }
  }
  create(map, owner, state) {
    this.prune(map);
    if ([...map.values()].some((entry) => entry.state === "scanning"))
      throw transfer_error("busy");
    if (map.size >= 3) {
      const oldest = map.values().next().value;
      oldest.controller.abort();
      map.delete(oldest.id);
    }
    const entry = {
      id: randomUUID(),
      owner,
      state,
      files_checked: 0,
      summary: null,
      error: null,
      controller: new AbortController(),
      deadline: this.now() + 1800 * 1000,
    };
    entry.signal = AbortSignal.any([
      entry.controller.signal,
      AbortSignal.timeout(1800 * 1000),
    ]);
    map.set(entry.id, entry);
    return entry;
  }
  get(map, id, owner) {
    const previous = map.get(id);
    if (previous?.owner === owner && previous.deadline <= this.now()) {
      previous.controller.abort();
      map.delete(id);
      throw transfer_error("expired", 410);
    }
    this.prune(map);
    const entry = map.get(id);
    if (!entry || entry.owner !== owner)
      throw transfer_error("session_not_found", 404);
    return entry;
  }
  start_export(owner) {
    const entry = this.create(this.exports, owner, "scanning");
    entry.work = build_transfer_package(this.directory, {
      signal: entry.signal,
      on_progress: (count) => {
        entry.files_checked = count;
      },
    })
      .then((result) => {
        entry.package = result;
        entry.manifest_sha256 = json_hash(result.manifest);
        entry.deadline = this.now() + TRANSFER_LIMITS.preview_seconds * 1000;
        entry.state = "ready";
      })
      .catch((error) => this.failure(entry, error));
    return entry;
  }
  start_session(
    owner,
    manifest,
    catalog_text,
    replacement_policy = "preserve",
  ) {
    const canonical = validate_package(manifest, catalog_text);
    const entry = this.create(this.sessions, owner, "scanning");
    entry.replacement_policy = replacement_policy;
    entry.files_total = canonical.files.length;
    entry.package = { manifest: canonical, catalog_text };
    entry.manifest_sha256 = json_hash(canonical);
    entry.work = this.scan_receiver(entry, canonical).catch((error) =>
      this.failure(entry, error),
    );
    return entry;
  }
  failure(entry, error) {
    entry.state = entry.controller.signal.aborted ? "cancelled" : "failed";
    entry.error = public_transfer_error(
      entry.controller.signal.aborted
        ? transfer_error("cancelled", 503)
        : error,
    );
    if (entry.signal.aborted && !entry.controller.signal.aborted)
      entry.error = public_transfer_error(transfer_error("timeout", 503));
  }
  async scan_receiver(entry, manifest) {
    const signal = entry.signal;
    const files = [];
    const live_files = [];
    let matching = 0,
      missing = 0,
      missing_bytes = 0,
      conflicts = 0,
      replacement_files = 0,
      replacement_bytes = 0,
      largest = 0;
    const conflict_ids = [];
    for (const file of manifest.files) {
      const live = await InstrumentPreviewStore.prototype.observe_receiver.call(
        this,
        entry,
        file,
        signal,
      );
      live_files.push({
        file_id: file.file_id,
        sha256: live?.sha256 ?? null,
        bytes: live?.bytes ?? null,
      });
      if (live && (live.sha256 !== file.sha256 || live.bytes !== file.bytes))
        replacement_files++;
      const observed = await this.observe_receiver(entry, file, signal, live);
      const state = !observed
        ? "missing"
        : observed.sha256 === file.sha256 && observed.bytes === file.bytes
          ? "matching"
          : "conflict";
      files.push({
        file_id: file.file_id,
        state,
        sha256: observed?.sha256 ?? null,
        bytes: observed?.bytes ?? null,
      });
      if (state === "matching") matching++;
      else if (state === "missing") {
        missing++;
        missing_bytes += file.bytes;
        largest = Math.max(largest, file.bytes);
      } else {
        conflicts++;
        replacement_bytes += file.bytes;
        largest = Math.max(largest, file.bytes);
        if (conflict_ids.length < 100) conflict_ids.push(file.file_id);
      }
      entry.files_checked++;
    }
    // The publication compare-and-swap identity is always the LIVE catalog;
    // a verified staged catalog can satisfy bytes without already being installed.
    const target_catalog =
      (
        await observe_transfer_file(this.directory, "catalog.json", {
          signal,
          max_bytes: MAX_CATALOG_BYTES,
        })
      )?.sha256 ?? null;
    const storage = await this.storage(this.directory, this.persistent);
    signal.throwIfAborted();
    const required = missing_bytes + replacement_bytes + largest + 1024 ** 3;
    entry.target_snapshot_sha256 = json_hash({
      catalog_sha256: target_catalog,
      files,
      live_files,
    });
    entry.observations = files;
    entry.live_observations = live_files;
    entry.summary = {
      source_catalog_sha256: manifest.catalog_sha256,
      target_catalog_sha256: target_catalog,
      package_files: manifest.files.length,
      package_bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
      matching_files: matching,
      missing_files: missing,
      missing_bytes,
      conflict_files: conflicts,
      replacement_bytes,
      replacement_files,
      conflict_file_ids: conflict_ids,
      free_bytes: storage.free_bytes,
      required_free_bytes: required,
      publication_state: "unchanged",
    };
    const reason =
      entry.replacement_policy !== "source" &&
      target_catalog &&
      target_catalog !== manifest.catalog_sha256
        ? "catalog_conflict"
        : entry.replacement_policy !== "source" && conflicts
          ? "file_conflict"
          : !storage.ready
            ? "storage_not_ready"
            : storage.free_bytes < required
              ? "insufficient_space"
              : null;
    entry.state = reason ? "blocked" : "ready";
    entry.deadline = this.now() + TRANSFER_LIMITS.preview_seconds * 1000;
    entry.error = reason ? public_transfer_error(transfer_error(reason)) : null;
  }
  observe_receiver(_entry, file, signal, live = undefined) {
    if (live !== undefined) return live;
    return observe_transfer_file(this.directory, file.relative_path, {
      signal,
      max_bytes:
        file.kind === "catalog"
          ? MAX_CATALOG_BYTES
          : TRANSFER_LIMITS.file_bytes,
    });
  }
  status(entry, exporting = false) {
    return exporting
      ? {
          protocol_version: 1,
          state: entry.state,
          files_checked: entry.files_checked,
          manifest_sha256: entry.manifest_sha256 ?? null,
          error: entry.error,
        }
      : {
          protocol_version: 1,
          session_id: entry.id,
          state: entry.state,
          manifest_sha256: entry.manifest_sha256,
          progress: {
            files_checked: entry.files_checked,
            files_verified: entry.summary?.matching_files ?? 0,
            files_total: entry.files_total,
            bytes_transferred: 0,
            bytes_to_transfer:
              (entry.summary?.missing_bytes ?? 0) +
              (entry.summary?.replacement_bytes ?? 0),
            current_file_id: null,
          },
          summary: entry.summary,
          target_snapshot_sha256: entry.target_snapshot_sha256 ?? null,
          receipt: null,
          error: entry.error,
        };
  }
  cancel(map, id, owner) {
    const entry = this.get(map, id, owner);
    entry.controller.abort();
    entry.state = "cancelled";
    return entry;
  }
}
