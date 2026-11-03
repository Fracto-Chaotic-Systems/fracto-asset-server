import { verify_drum_manifests } from "./drum-assets.js";
import { catalog_libraries, MAX_CATALOG_BYTES } from "./catalog-libraries.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { verify_indexes } from "./pitch-index.js";

export const valid_id = (value) =>
  typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const content_hash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const valid_hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stamp = (stat) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const pick = (value, fields) =>
  Object.fromEntries(fields.map((key) => [key, value[key]]));

export function create_instrument_library(directory) {
  const root = path.resolve(directory);
  let cache = null,
    pending = null;
  const hashes = new Map();
  async function build(key) {
    if (
      (await fsp.stat(path.join(root, "catalog.json"))).size > MAX_CATALOG_BYTES
    )
      throw new Error("Instrument catalog too large");
    const content = await fsp.readFile(path.join(root, "catalog.json"));
    if (content.length > MAX_CATALOG_BYTES)
      throw new Error("Instrument catalog too large");
    const catalog = JSON.parse(content);
    if (
      catalog.schema_version !== 1 ||
      !Number.isInteger(catalog.library_version) ||
      !Array.isArray(catalog.instruments)
    )
      throw new Error("Invalid instrument catalog");
    const library_metadata = catalog_libraries(catalog);
    verify_indexes(root, catalog);
    verify_drum_manifests(root, catalog);
    const instruments = new Map(),
      assets = new Map();
    for (const instrument of catalog.instruments) {
      if (
        !valid_id(instrument.id) ||
        instruments.has(instrument.id) ||
        typeof instrument.name !== "string" ||
        !Array.isArray(instrument.recordings) ||
        !Array.isArray(instrument.playback_assets)
      )
        throw new Error("Invalid instrument metadata");
      instruments.set(instrument.id, instrument);
      for (const [kind, entries] of [
        ["original", instrument.recordings],
        ["playback", instrument.playback_assets],
      ]) {
        for (const entry of entries) {
          const relative =
            kind === "original"
              ? `originals/${entry.filename}`
              : `playback/${entry.recording_id}/${entry.sha256}.wav`;
          if (
            !valid_id(entry.id) ||
            !valid_hash(entry.sha256) ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes <= 0 ||
            entry.path !== relative ||
            (kind === "original" &&
              (!/^[A-Za-z0-9_-]+\.(mp3|wav)$/.test(entry.filename) ||
                entry.mime_type !==
                  (entry.filename.endsWith(".wav")
                    ? "audio/wav"
                    : "audio/mpeg"))) ||
            (kind === "playback" &&
              !instrument.recordings.some(
                (recording) => recording.id === entry.recording_id,
              ))
          )
            throw new Error("Invalid registered audio");
          const id = `${instrument.id}/${entry.id}`;
          if (assets.has(id)) throw new Error("Duplicate registered audio");
          assets.set(id, {
            kind,
            instrument_id: instrument.id,
            entry,
            relative,
          });
        }
      }
    }
    for (const kit of library_metadata.drum_kits)
      for (const entry of kit.playback_assets) {
        const id = `${kit.id}/${entry.id}`;
        if (assets.has(id)) throw new Error("Duplicate kit asset ID");
        assets.set(id, {
          kind: "drum-playback",
          instrument_id: kit.id,
          entry,
          relative: `playback/${kit.id}/${entry.sha256}.wav`,
        });
      }
    const after = await fsp.stat(path.join(root, "catalog.json"), {
      bigint: true,
    });
    if (stamp(after) !== key)
      throw new Error("Instrument catalog changed during read");
    hashes.clear();
    return {
      stamp: key,
      revision: content_hash(content),
      catalog,
      library_metadata,
      instruments,
      assets,
    };
  }
  async function load() {
    const stat = await fsp.stat(path.join(root, "catalog.json"), {
      bigint: true,
    });
    const key = stamp(stat);
    if (cache?.stamp === key) return cache;
    if (pending?.key === key) return pending.work;
    const work = build(key);
    pending = { key, work };
    try {
      const result = await work;
      if (pending?.work === work) cache = result;
      return result;
    } finally {
      if (pending?.work === work) pending = null;
    }
  }
  async function locate(asset) {
    try {
      let filename = root;
      for (const part of asset.relative.split("/")) {
        filename = path.join(filename, part);
        if ((await fsp.lstat(filename)).isSymbolicLink()) return null;
      }
      const real_root = await fsp.realpath(root),
        real_file = await fsp.realpath(filename);
      if (!real_file.startsWith(real_root + path.sep)) return null;
      const stat = await fsp.stat(real_file, { bigint: true });
      if (!stat.isFile() || Number(stat.size) !== asset.entry.bytes)
        return null;
      return {
        filename: real_file,
        stamp: stamp(stat),
        size: Number(stat.size),
      };
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code))
        return null;
      throw error;
    }
  }
  async function verify_audio(asset, location) {
    const cached = hashes.get(location.filename);
    if (
      cached?.stamp === location.stamp &&
      cached.sha256 === asset.entry.sha256
    )
      return;
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(location.filename))
      hash.update(chunk);
    if (hash.digest("hex") !== asset.entry.sha256)
      throw new Error("Audio integrity check failed");
    const after = await locate(asset);
    if (!after || after.stamp !== location.stamp)
      throw new Error("Audio changed during verification");
    hashes.set(location.filename, {
      stamp: location.stamp,
      sha256: asset.entry.sha256,
    });
  }
  return { load, locate, verify_audio };
}

export function public_catalog(snapshot, available, url_for) {
  const instruments = [...snapshot.instruments.values()].map((instrument) => {
    const recordings = instrument.recordings.map((recording) => ({
      ...pick(recording, [
        "id",
        "velocity_layer",
        "sha256",
        "bytes",
        "mime_type",
        "verification_status",
      ]),
      timing: recording.timing
        ? pick(recording.timing, [
            "method_version",
            "slot_seconds",
            "zero_pitch",
            "duration_seconds",
            "sample_rate",
            "channels",
            "available_pitches",
          ])
        : null,
      available: available.has(`${instrument.id}/${recording.id}`),
      url: available.has(`${instrument.id}/${recording.id}`)
        ? url_for(instrument.id, recording)
        : null,
    }));
    const playback_assets = instrument.playback_assets.map((asset) => ({
      ...pick(asset, [
        "id",
        "recording_id",
        "velocity_layer",
        "method_version",
        "sha256",
        "bytes",
        "mime_type",
        "encoding",
        "sample_rate",
        "channels",
        "frames",
        "duration_seconds",
        "decoded_bytes_at_48000",
      ]),
      notes: asset.notes.map((note) =>
        pick(note, [
          "midi_pitch",
          "offset_frames",
          "frames",
          "onset_frame",
          "offset_seconds",
          "duration_seconds",
          "tail_guarded",
        ]),
      ),
      available: available.has(`${instrument.id}/${asset.id}`),
      url: available.has(`${instrument.id}/${asset.id}`)
        ? url_for(instrument.id, asset)
        : null,
    }));
    return {
      ...pick(instrument, [
        "id",
        "name",
        "kind",
        "enabled",
        "verification_status",
        "midi_programs",
        "banks",
      ]),
      library_id: instrument.library_id ?? "legacy",
      instrument_key: instrument.instrument_key ?? instrument.id,
      available:
        playback_assets.length > 0 &&
        playback_assets.every((asset) => asset.available),
      available_pitches: instrument.pitch_map?.available_pitches ?? [],
      common_pitches: instrument.pitch_map?.common_pitches ?? [],
      recordings,
      playback_assets,
    };
  });
  return {
    schema_version: 1,
    drum_kits: snapshot.library_metadata.drum_kits.map((kit) => ({
      ...pick(kit, [
        "id",
        "library_id",
        "kit_key",
        "kind",
        "name",
        "midi_program",
        "midi_bank",
        "source_preset",
        "source_sha256",
        "enabled",
        "verification_status",
        "coverage_status",
        "playback_mode",
      ]),
      midi_bank: pick(kit.midi_bank, ["msb", "lsb"]),
      source_preset: pick(kit.source_preset, ["bank", "program"]),
      notes: kit.notes.map((note) =>
        pick(note, ["midi_note", "velocity_ranges"]),
      ),
      choke_groups: kit.choke_groups.map((group) =>
        pick(group, ["source_exclusive_class", "midi_notes"]),
      ),
      rendering: kit.rendering
        ? pick(kit.rendering, [
            "method_version",
            "config_sha256",
            "renderer_lock_sha256",
            "renderer_version",
          ])
        : undefined,
      available:
        kit.enabled &&
        kit.verification_status === "playback_verified" &&
        kit.playback_assets.length > 0 &&
        kit.playback_assets.every((asset) =>
          available.has(`${kit.id}/${asset.id}`),
        ),
      assets_available:
        kit.playback_assets.length > 0 &&
        kit.playback_assets.every((asset) =>
          available.has(`${kit.id}/${asset.id}`),
        ),
      available_notes:
        kit.enabled &&
        kit.verification_status === "playback_verified" &&
        kit.playback_assets.length > 0 &&
        kit.playback_assets.every((asset) =>
          available.has(`${kit.id}/${asset.id}`),
        )
          ? kit.notes.map((note) => note.midi_note)
          : [],
      recordings: [],
      playback_assets: kit.playback_assets.map((asset) => ({
        ...pick(asset, [
          "id",
          "method_version",
          "sha256",
          "bytes",
          "mime_type",
          "encoding",
          "sample_rate",
          "channels",
          "frames",
          "duration_seconds",
          "decoded_bytes_at_48000",
          "source_sha256",
          "render_config_sha256",
        ]),
        hits: asset.hits.map((hit) =>
          pick(hit, [
            "midi_note",
            "velocity_min",
            "velocity_max",
            "render_velocity",
            "offset_frames",
            "frames",
            "offset_seconds",
            "duration_seconds",
            "pcm_sha256",
          ]),
        ),
        available: available.has(`${kit.id}/${asset.id}`),
        url: available.has(`${kit.id}/${asset.id}`)
          ? url_for(kit.id, asset)
          : null,
      })),
    })),
    default_library_id: snapshot.library_metadata.default_library_id,
    libraries: snapshot.library_metadata.libraries.map((library) =>
      pick(library, [
        "id",
        "name",
        "version",
        "source_format",
        "status",
        "license",
        "source_url",
        "source_revision",
        "percussion_library_id",
      ]),
    ),
    library_version: snapshot.catalog.library_version,
    revision: snapshot.revision,
    browser_verification:
      snapshot.catalog.playback_preparation?.browser_verification ?? "pending",
    instruments,
  };
}
