import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  durable_file,
  install_link,
  remove_candidate,
} from "./transfer_persistence.js";
import { safe_transfer_path, observe_transfer_file } from "./transfer_files.js";
import { staging_path, transfer_parent } from "./transfer_staging.js";
import {
  assert_observation,
  backup_observation,
  install_replacement,
} from "./transfer_replacement.js";
import { validate_package } from "./transfer_package.js";
import { validate_instrument_directory } from "./transfer_validation.js";
import {
  create_instrument_library,
  invalidate_instrument_library,
} from "./http-library.js";
import {
  is_hash,
  json_hash,
  public_transfer_error,
  transfer_error,
  TRANSFER_LIMITS,
} from "@fracto/sdk/utils/InstrumentTransfer.js";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const journal_path = (id) => `.instrument-transfer/sessions/${id}.json`;
export class InstrumentPublication {
  constructor(
    store,
    { validate = validate_instrument_directory, hook = async () => {} } = {},
  ) {
    this.store = store;
    this.root = store.directory;
    this.validate = validate;
    this.hook = hook;
    this.journals = new Map();
  }
  initialize() {
    return (this.initializing ??= this.recover());
  }
  async read(id) {
    if (!UUID.test(id)) throw transfer_error("session_not_found", 404);
    const file = await observe_transfer_file(this.root, journal_path(id), {
      max_bytes: TRANSFER_LIMITS.preview_request_bytes,
      text: true,
    });
    if (!file) return null;
    let record;
    try {
      record = JSON.parse(file.text);
    } catch {
      throw transfer_error("storage_not_ready", 503);
    }
    if (
      record.schema_version !== 1 ||
      record.id !== id ||
      !is_hash(record.owner) ||
      !Number.isSafeInteger(record.created_at) ||
      !Number.isSafeInteger(record.updated_at) ||
      !record.status ||
      record.status.session_id !== id ||
      !is_hash(record.status.manifest_sha256)
    )
      throw transfer_error("storage_not_ready", 503);
    if (record.phase === "completed") {
      const receipt = record.status.receipt,
        summary = record.status.summary;
      if (
        record.status.state !== "completed" ||
        receipt?.protocol_version !== 1 ||
        !is_hash(receipt.catalog_sha256) ||
        !Number.isSafeInteger(receipt.files_verified) ||
        receipt.files_verified < 1 ||
        !Number.isSafeInteger(receipt.bytes_verified) ||
        receipt.bytes_verified < 1 ||
        summary?.publication_state !== "published" ||
        receipt.manifest_sha256 !== record.status.manifest_sha256 ||
        receipt.catalog_sha256 !== summary?.source_catalog_sha256 ||
        receipt.files_verified !== summary?.package_files ||
        receipt.bytes_verified !== summary?.package_bytes ||
        !Number.isFinite(Date.parse(receipt.completed_at))
      )
        throw transfer_error("storage_not_ready", 503);
    }
    return record;
  }
  async save(entry, phase, status = this.store.status(entry)) {
    entry.created_at ??= this.store.now();
    for (const [id, updated] of this.journals)
      if (updated + RETAIN_MS <= this.store.now()) {
        await fsp
          .unlink(await safe_transfer_path(this.root, journal_path(id)))
          .catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        this.journals.delete(id);
      }
    if (!this.journals.has(entry.id) && this.journals.size >= 512)
      throw transfer_error("limit_exceeded", 413);
    const record = {
      schema_version: 1,
      id: entry.id,
      owner: entry.owner,
      created_at: entry.created_at,
      updated_at: this.store.now(),
      phase,
      status,
      plan_sha256: entry.plan_sha256,
      ...(["catalog_intent", "verifying"].includes(phase)
        ? { package: entry.package }
        : {}),
    };
    const content = JSON.stringify(record);
    if (Buffer.byteLength(content) > TRANSFER_LIMITS.preview_request_bytes)
      throw transfer_error("limit_exceeded", 413);
    await durable_file(this.root, journal_path(entry.id), content, {
      replace: true,
    });
    this.journals.set(entry.id, record.updated_at);
    entry.journal_phase = phase;
  }
  restored(record) {
    return {
      id: record.id,
      owner: record.owner,
      state: record.status.state,
      created_at: record.created_at,
      plan_sha256: record.plan_sha256,
      deadline: record.updated_at + RETAIN_MS,
      recovered_status: record.status,
      controller: new AbortController(),
      inflight: new Map(),
      acknowledged: new Set(),
    };
  }
  async lookup(id, owner) {
    const record = await this.read(id);
    if (
      !record ||
      record.owner !== owner ||
      record.updated_at + RETAIN_MS <= this.store.now()
    )
      throw transfer_error("session_not_found", 404);
    return this.restored(record);
  }
  async recover() {
    const directory = await safe_transfer_path(
      this.root,
      ".instrument-transfer/sessions",
    );
    let entries;
    try {
      entries = await fsp.readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const ids = entries
      .filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5)))
      .map((name) => name.slice(0, -5));
    if (ids.length > 10000) throw transfer_error("storage_not_ready", 503);
    let latest,
      retained = 0;
    for (const id of ids) {
      const record = await this.read(id);
      if (record.updated_at + RETAIN_MS <= this.store.now()) {
        await fsp.unlink(await safe_transfer_path(this.root, journal_path(id)));
        continue;
      }
      if (++retained > 512) throw transfer_error("storage_not_ready", 503);
      this.journals.set(id, record.updated_at);
      if (record.phase === "completed") continue;
      if (
        ["catalog_intent", "verifying"].includes(record.phase) &&
        (!latest || record.updated_at >= latest.updated_at)
      ) {
        if (latest) await this.interrupt(latest);
        latest = record;
      } else if (!["partial", "failed", "cancelled"].includes(record.phase))
        await this.interrupt(record);
    }
    if (latest) {
      const manifest = validate_package(
        latest.package?.manifest,
        latest.package?.catalog_text,
      );
      if (json_hash(manifest) !== latest.status.manifest_sha256)
        throw transfer_error("storage_not_ready", 503);
      const entry = {
        ...this.restored(latest),
        package: { ...latest.package, manifest },
        recovered_status: undefined,
        manifest_sha256: latest.status.manifest_sha256,
        plan_sha256: latest.plan_sha256,
        files_total: manifest.files.length,
        files_checked: 0,
        summary: latest.status.summary,
        error: null,
        inflight: new Map(),
        acknowledged: new Set(),
        state: "verifying",
        finalizing: true,
        critical: true,
        durable_changes: true,
      };
      this.store.sessions.set(entry.id, entry);
      this.store.acquire(entry);
      entry.work = this.transaction(entry, async () => {
        await this.verify_live(entry);
        await this.complete(entry);
      });
    }
  }
  async interrupt(record) {
    const status = {
      ...record.status,
      state: "partial",
      receipt: null,
      summary: record.status.summary
        ? { ...record.status.summary, publication_state: "unknown" }
        : null,
      error: public_transfer_error(transfer_error("interrupted", 503)),
    };
    await durable_file(
      this.root,
      journal_path(record.id),
      JSON.stringify({
        ...record,
        package: undefined,
        phase: "partial",
        status,
        updated_at: this.store.now(),
      }),
      { replace: true },
    );
  }
  async transaction(entry, action) {
    const heartbeat = setInterval(() => this.store.touch(entry), 1000);
    heartbeat.unref?.();
    try {
      await action();
    } catch (error) {
      entry.state =
        entry.durable_changes || entry.acknowledged.size
          ? "partial"
          : entry.signal.aborted &&
              entry.signal.reason?.code === "instrument_transfer_cancelled"
            ? "cancelled"
            : "failed";
      entry.receipt = null;
      entry.error = public_transfer_error(error);
      entry.summary.publication_state = entry.critical
        ? "unknown"
        : "unchanged";
      await this.save(entry, entry.state).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      if (entry.candidate_relative)
        await remove_candidate(this.root, entry.candidate_relative).catch(
          () => {},
        );
      await this.store.unlock(entry);
      entry.finalizing = false;
      entry.critical = false;
    }
  }
  async candidate(entry) {
    const relative = `.instrument-transfer/candidates/${randomUUID()}`;
    entry.candidate_relative = relative;
    await transfer_parent(this.root, `${relative}/catalog.json`);
    for (const file of entry.package.manifest.files) {
      entry.signal.throwIfAborted();
      const live = await observe_transfer_file(this.root, file.relative_path, {
        signal: entry.signal,
        max_bytes: TRANSFER_LIMITS.file_bytes,
      });
      const matching =
        live?.sha256 === file.sha256 && live.bytes === file.bytes;
      const source_relative = matching
        ? file.relative_path
        : staging_path(entry.manifest_sha256, file);
      const observed =
        (matching ? live : null) ??
        (await observe_transfer_file(this.root, source_relative, {
          signal: entry.signal,
          max_bytes: file.bytes,
        }));
      if (observed?.sha256 !== file.sha256 || observed.bytes !== file.bytes)
        throw transfer_error("verification_failed", 503);
      await transfer_parent(this.root, `${relative}/${file.relative_path}`);
      await fsp.link(
        await safe_transfer_path(this.root, source_relative),
        await safe_transfer_path(
          this.root,
          `${relative}/${file.relative_path}`,
        ),
      );
      this.store.touch(entry);
    }
    await this.validate(path.join(this.root, relative), {
      signal: entry.signal,
    });
    return relative;
  }
  async publish(entry) {
    await this.save(entry, "validating");
    entry.state = "validating";
    const storage = await this.store.storage(this.root, this.store.persistent);
    if (!storage.ready || storage.free_bytes < 1024 ** 3)
      throw transfer_error("storage_not_ready", 503);
    const candidate = await this.candidate(entry);
    await this.hook("candidate_validated", entry);
    await this.assert_catalog(entry);
    if (entry.replacement_policy === "source")
      for (const file of entry.package.manifest.files)
        await assert_observation(
          this.root,
          file,
          entry.live_observations.find((o) => o.file_id === file.file_id),
          entry.signal,
        );
    await this.save(entry, "installing");
    for (const file of entry.package.manifest.files.filter(
      (file) => file.kind !== "catalog",
    )) {
      entry.signal.throwIfAborted();
      await this.install(
        entry,
        this.root,
        `${candidate}/${file.relative_path}`,
        file,
        () => {
          entry.durable_changes = true;
        },
      );
      await this.hook("dependency_installed", entry);
    }
    await this.assert_catalog(entry);
    const previous = entry.summary.target_catalog_sha256;
    if (previous && entry.replacement_policy === "source") {
      const file = entry.package.manifest.files.find(
        (f) => f.kind === "catalog",
      );
      await backup_observation(
        this.root,
        file,
        entry.live_observations.find((o) => o.file_id === file.file_id),
        `.instrument-transfer/backups/${previous}.json`,
      );
    } else if (previous) {
      const backup = `.instrument-transfer/backups/${previous}.json`;
      const current = await observe_transfer_file(this.root, "catalog.json", {
        max_bytes: 32 * 1024 * 1024,
        text: true,
      });
      if (current?.sha256 !== previous)
        throw transfer_error("snapshot_changed");
      try {
        await durable_file(this.root, backup, current.text);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const proof = await observe_transfer_file(this.root, backup, {
        max_bytes: 32 * 1024 * 1024,
      });
      if (proof?.sha256 !== previous)
        throw transfer_error("verification_failed", 503);
    }
    entry.signal.throwIfAborted();
    entry.critical = true;
    entry.state = "publishing";
    await this.save(entry, "catalog_intent");
    await this.hook("catalog_intent", entry);
    await this.assert_catalog(entry);
    if (!previous || previous !== entry.package.manifest.catalog_sha256) {
      const catalog = entry.package.manifest.files.find(
        (file) => file.kind === "catalog",
      );
      await this.install(
        entry,
        this.root,
        `${candidate}/catalog.json`,
        catalog,
        () => {
          entry.durable_changes = true;
        },
      );
    }
    // Removing hard links changes inode ctime, including the unchanged catalog.
    // Settle candidate cleanup before final hashing/cache reload and the receipt.
    await remove_candidate(this.root, candidate);
    entry.candidate_relative = null;
    invalidate_instrument_library(this.root);
    await this.hook("catalog_committed", entry);
    entry.state = "verifying";
    await this.save(entry, "verifying");
    await this.verify_live(entry);
    await this.complete(entry);
  }
  install(entry, root, source_relative, file, on_change) {
    if (entry.replacement_policy !== "source")
      return install_link(root, source_relative, file, on_change);
    return install_replacement(
      root,
      source_relative,
      file,
      entry.live_observations.find((o) => o.file_id === file.file_id),
      `.instrument-transfer/backups/${entry.id}/${file.relative_path}`,
      on_change,
    );
  }
  async assert_catalog(entry) {
    const current = await observe_transfer_file(this.root, "catalog.json", {
      signal: entry.signal,
      max_bytes: 32 * 1024 * 1024,
    });
    if ((current?.sha256 ?? null) !== entry.summary.target_catalog_sha256)
      throw transfer_error("snapshot_changed");
  }
  async verify_live(entry) {
    for (const file of entry.package.manifest.files) {
      const observed = await observe_transfer_file(
        this.root,
        file.relative_path,
        { signal: entry.signal, max_bytes: file.bytes },
      );
      if (observed?.sha256 !== file.sha256 || observed.bytes !== file.bytes)
        throw transfer_error("verification_failed", 503);
      this.store.touch(entry);
    }
    await this.validate(path.resolve(this.root), { signal: entry.signal });
    invalidate_instrument_library(this.root);
    const library = create_instrument_library(this.root),
      snapshot = await library.load();
    if (snapshot.revision !== entry.package.manifest.catalog_sha256)
      throw transfer_error("verification_failed", 503);
    for (const asset of snapshot.assets.values())
      if (!(await library.locate(asset)))
        throw transfer_error("verification_failed", 503);
  }
  async complete(entry) {
    const receipt = {
      protocol_version: 1,
      manifest_sha256: entry.manifest_sha256,
      catalog_sha256: entry.package.manifest.catalog_sha256,
      files_verified: entry.files_total,
      bytes_verified: entry.package.manifest.files.reduce(
        (n, file) => n + file.bytes,
        0,
      ),
      completed_at: new Date(this.store.now()).toISOString(),
    };
    const status = {
      ...this.store.status(entry),
      state: "completed",
      error: null,
      receipt,
      progress: {
        ...this.store.status(entry).progress,
        files_verified: entry.files_total,
      },
      summary: { ...entry.summary, publication_state: "published" },
    };
    await this.save(entry, "completed", status);
    entry.receipt = receipt;
    entry.state = "completed";
    entry.error = null;
    entry.summary.publication_state = "published";
    entry.deadline = this.store.now() + RETAIN_MS;
  }
}
