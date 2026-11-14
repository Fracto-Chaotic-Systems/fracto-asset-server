import { catalog_libraries, MAX_CATALOG_BYTES } from "./catalog-libraries.js";
import { create_instrument_library } from "./http-library.js";
import { observe_transfer_file } from "./transfer_files.js";
import {
  canonical_manifest,
  transfer_hash,
  is_hash,
  TRANSFER_LIMITS,
  transfer_error,
} from "../../../utils/instrument_transfer.js";

export const SUPPORT_FILES = Object.freeze({
  legacy: [],
  "fluidr3-gm": [
    "source-lock.json",
    "NOTICE.md",
    "upstream/LICENSE.txt",
    "upstream/README.md",
  ],
  "fluidr3-percussion": [
    "README.md",
    "source-lock.json",
    "kit-inventory.json",
    "renderer-lock.json",
    "upstream/COPYING",
    "upstream/README",
    "upstream/README.md",
    "upstream/FLUIDSYNTH-LICENSE",
  ],
});
export const INDEX_METHODS = ["chromatic-index-v1", "fluidr3-note-samples-v1"];
export const AUDIO_METHODS = ["mono-octave-pcm16-v1", "sf2-drum-hits-pcm16-v1"];
const id = (value) =>
  typeof value === "string" &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
  value.length <= 128;
const invalid = () => {
  throw transfer_error("invalid_manifest", 400);
};

// Derive paths from catalog identities on both sides, never from remote filenames alone.
export function package_dependencies(catalog_text) {
  if (
    typeof catalog_text !== "string" ||
    Buffer.byteLength(catalog_text) > MAX_CATALOG_BYTES
  )
    invalid();
  let catalog, metadata;
  try {
    catalog = JSON.parse(catalog_text);
    if (
      catalog.schema_version !== 1 ||
      !Number.isSafeInteger(catalog.library_version) ||
      catalog.library_version < 1
    )
      invalid();
    metadata = catalog_libraries(catalog);
  } catch {
    invalid();
  }
  const files = new Map();
  const add = (kind, relative_path, sha256 = null, bytes = null) => {
    const next = { kind, relative_path, sha256, bytes };
    const previous = files.get(relative_path);
    if (previous && JSON.stringify(previous) !== JSON.stringify(next))
      invalid();
    if (sha256 !== null && !is_hash(sha256)) invalid();
    if (
      bytes !== null &&
      (!Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > TRANSFER_LIMITS.file_bytes)
    )
      invalid();
    files.set(relative_path, next);
  };
  add(
    "catalog",
    "catalog.json",
    transfer_hash(catalog_text),
    Buffer.byteLength(catalog_text),
  );
  for (const library of metadata.libraries) {
    if (!Object.hasOwn(SUPPORT_FILES, library.id))
      throw transfer_error("upgrade_required");
    for (const relative of SUPPORT_FILES[library.id])
      add("support", `${library.id}/${relative}`);
  }
  const check_method = (method, list) => {
    if (!list.includes(method)) throw transfer_error("upgrade_required");
  };
  for (const instrument of catalog.instruments) {
    if (
      !id(instrument.id) ||
      !Array.isArray(instrument.recordings) ||
      !Array.isArray(instrument.playback_assets)
    )
      invalid();
    const recordings = new Map();
    for (const recording of instrument.recordings) {
      if (
        !id(recording.id) ||
        recordings.has(recording.id) ||
        !is_hash(recording.sha256) ||
        !Number.isSafeInteger(recording.bytes) ||
        recording.bytes < 1 ||
        typeof recording.filename !== "string" ||
        !/^[A-Za-z0-9_-]+\.(mp3|wav)$/.test(recording.filename) ||
        recording.path !== `originals/${recording.filename}`
      )
        invalid();
      recordings.set(recording.id, recording);
      add("original", recording.path, recording.sha256, recording.bytes);
      if (recording.timing) {
        if (!is_hash(recording.timing.index_sha256)) invalid();
        check_method(recording.timing.method_version, INDEX_METHODS);
        if (recording.timing.index_path !== `indexes/${recording.id}.json`)
          invalid();
        add(
          "index",
          recording.timing.index_path,
          recording.timing.index_sha256,
        );
      }
    }
    for (const asset of instrument.playback_assets) {
      if (
        !id(asset.id) ||
        !is_hash(asset.sha256) ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 1 ||
        !recordings.has(asset.recording_id) ||
        asset.path !== `playback/${asset.recording_id}/${asset.sha256}.wav`
      )
        invalid();
      check_method(asset.method_version, [AUDIO_METHODS[0]]);
      add("playback", asset.path, asset.sha256, asset.bytes);
    }
    for (const reference of instrument.pitch_map?.indexes ?? []) {
      const recording = recordings.get(reference.recording_id);
      if (
        !recording?.timing ||
        reference.path !== recording.timing.index_path ||
        reference.sha256 !== recording.timing.index_sha256
      )
        invalid();
    }
  }
  for (const kit of metadata.drum_kits) {
    if (kit.verification_status === "source_audited") continue;
    check_method(kit.rendering.method_version, [AUDIO_METHODS[1]]);
    const relative = `indexes/${kit.id}-${kit.rendering.config_sha256.slice(0, 12)}-render.json`;
    if (kit.rendering.manifest_path !== relative) invalid();
    add("index", relative, kit.rendering.manifest_sha256);
    for (const asset of kit.playback_assets) {
      if (asset.path !== `playback/${kit.id}/${asset.sha256}.wav`) invalid();
      add("playback", asset.path, asset.sha256, asset.bytes);
    }
  }
  return { catalog, files };
}

export function validate_package(manifest_value, catalog_text) {
  const manifest = canonical_manifest(manifest_value);
  const dependencies = package_dependencies(catalog_text);
  if (manifest.files.length !== dependencies.files.size) invalid();
  for (const file of manifest.files) {
    const expected = dependencies.files.get(file.relative_path);
    if (
      !expected ||
      expected.kind !== file.kind ||
      (expected.sha256 !== null && expected.sha256 !== file.sha256) ||
      (expected.bytes !== null && expected.bytes !== file.bytes) ||
      (["catalog", "index", "support"].includes(file.kind) &&
        file.bytes > MAX_CATALOG_BYTES)
    )
      invalid();
  }
  return manifest;
}

export async function build_transfer_package(
  root,
  { signal, on_progress = () => {} } = {},
) {
  try {
    const source = await observe_transfer_file(root, "catalog.json", {
      signal,
      max_bytes: MAX_CATALOG_BYTES,
      text: true,
    });
    if (!source) throw transfer_error("source_incomplete", 422);
    const { files } = package_dependencies(source.text);
    const entries = [];
    for (const expected of files.values()) {
      signal?.throwIfAborted();
      const observed = await observe_transfer_file(
        root,
        expected.relative_path,
        {
          signal,
          max_bytes: ["index", "support", "catalog"].includes(expected.kind)
            ? MAX_CATALOG_BYTES
            : TRANSFER_LIMITS.file_bytes,
        },
      );
      if (
        !observed ||
        (expected.sha256 && expected.sha256 !== observed.sha256) ||
        (expected.bytes !== null && expected.bytes !== observed.bytes)
      )
        throw transfer_error("source_incomplete", 422);
      entries.push({
        file_id: transfer_hash(expected.relative_path),
        kind: expected.kind,
        relative_path: expected.relative_path,
        bytes: observed.bytes,
        sha256: observed.sha256,
      });
      on_progress(entries.length);
    }
    signal?.throwIfAborted();
    // Reuse the runtime's index/drum-manifest validation, including disabled entries.
    const snapshot = await create_instrument_library(root).load();
    signal?.throwIfAborted();
    if (snapshot.revision !== source.sha256)
      throw transfer_error("snapshot_changed");
    const manifest = validate_package(
      { protocol_version: 1, catalog_sha256: source.sha256, files: entries },
      source.text,
    );
    return { manifest, catalog_text: source.text };
  } catch (error) {
    if (signal?.aborted || error.code?.startsWith("instrument_transfer_"))
      throw error;
    throw transfer_error("source_incomplete", 422);
  }
}
