import { verify_playback } from "./playback-assets.js";
import { verify_indexes } from "./pitch-index.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  SEED_INSTRUMENTS,
  SOURCE_COMMIT,
  SOURCE_REMOTE,
} from "./seed-definitions.js";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const read_git = (repo, args) =>
  execFileSync(
    "git",
    [
      "-c",
      `safe.directory=${path.resolve(repo)}`,
      "-C",
      path.resolve(repo),
      ...args,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
const flat_mp3 = (name) =>
  typeof name === "string" && /^[A-Za-z0-9_-]+\.mp3$/.test(name);

function original_path(directory, filename) {
  if (!flat_mp3(filename))
    throw new Error(`Invalid recording filename: ${filename}`);
  const originals = path.join(path.resolve(directory), "originals");
  if (fs.existsSync(originals) && fs.lstatSync(originals).isSymbolicLink())
    throw new Error("The originals directory must not be a symbolic link.");
  const target = path.join(originals, filename);
  if (
    fs.existsSync(target) &&
    (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())
  )
    throw new Error(`Recording must be a regular file: ${filename}`);
  return target;
}

function validate_catalog(catalog) {
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.instruments))
    throw new Error("Invalid instrument catalog schema.");
  const ids = new Set(),
    files = new Set(),
    recordings = [];
  for (const instrument of catalog.instruments) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(instrument.id) ||
      ids.has(instrument.id) ||
      !instrument.name ||
      !Array.isArray(instrument.recordings) ||
      !instrument.recordings.length
    )
      throw new Error("Invalid or duplicate instrument ID.");
    ids.add(instrument.id);
    for (const recording of instrument.recordings) {
      if (
        !flat_mp3(recording.filename) ||
        files.has(recording.filename) ||
        recording.path !== `originals/${recording.filename}` ||
        !Number.isSafeInteger(recording.bytes) ||
        recording.bytes <= 0 ||
        !/^[0-9a-f]{64}$/.test(recording.sha256)
      )
        throw new Error("Invalid or duplicate recording metadata.");
      files.add(recording.filename);
      recordings.push(recording);
    }
  }
  return recordings;
}

export function seed_library({
  source_repo,
  directory,
  commit = SOURCE_COMMIT,
  definitions = SEED_INSTRUMENTS,
  remote = SOURCE_REMOTE,
}) {
  if (!source_repo) throw new Error("Supply --source-repo PATH.");
  const resolved_commit = read_git(source_repo, [
    "rev-parse",
    "--verify",
    `${commit}^{commit}`,
  ])
    .toString()
    .trim();
  const instruments = definitions.map((instrument) => ({
    id: instrument.id,
    name: instrument.name,
    kind: instrument.kind,
    enabled: false,
    verification_status: "pending",
    midi_programs: [],
    banks: [],
    pitch_map: null,
    playback_assets: [],
    recordings: instrument.recordings.map((definition) => {
      const { filename } = definition;
      if (!flat_mp3(filename)) throw new Error("Invalid source filename.");
      const source_path = `public/audio/${filename}`;
      const reference = `${resolved_commit}:${source_path}`;
      const bytes = read_git(source_repo, ["show", reference]);
      return {
        id: `${instrument.id}-${definition.velocity_layer ?? "main"}`,
        filename,
        path: `originals/${filename}`,
        mime_type: "audio/mpeg",
        bytes: bytes.length,
        sha256: sha256(bytes),
        velocity_layer: definition.velocity_layer ?? null,
        timing: null,
        verification_status: "pending",
        source: {
          path: source_path,
          git_blob: read_git(source_repo, ["rev-parse", reference])
            .toString()
            .trim(),
        },
      };
    }),
  }));
  const catalog = {
    schema_version: 1,
    library_version: 1,
    provenance: {
      repository: remote,
      commit: resolved_commit,
      commit_date: read_git(source_repo, [
        "show",
        "-s",
        "--format=%cI",
        resolved_commit,
      ])
        .toString()
        .trim(),
      original_creator: null,
      usage_terms: null,
    },
    instruments,
  };
  const recordings = validate_catalog(catalog);
  const catalog_path = path.join(path.resolve(directory), "catalog.json");
  // Preserve verified indexes and status while requiring unchanged seed identity.
  const identity = (value) => ({
    schema_version: value.schema_version,
    provenance: {
      repository: value.provenance.repository,
      commit: value.provenance.commit,
      commit_date: value.provenance.commit_date,
    },
    instruments: value.instruments.map((instrument) => ({
      id: instrument.id,
      name: instrument.name,
      kind: instrument.kind,
      recordings: instrument.recordings.map((recording) => ({
        id: recording.id,
        filename: recording.filename,
        path: recording.path,
        mime_type: recording.mime_type,
        bytes: recording.bytes,
        sha256: recording.sha256,
        velocity_layer: recording.velocity_layer,
        source: recording.source,
      })),
    })),
  });
  if (
    fs.existsSync(catalog_path) &&
    JSON.stringify(
      identity(JSON.parse(fs.readFileSync(catalog_path, "utf8"))),
    ) !== JSON.stringify(identity(catalog))
  )
    throw new Error(
      "Existing catalog differs from the seed; refusing to overwrite it.",
    );
  // Preflight every destination before writing any originals.
  for (const recording of recordings) {
    const target = original_path(directory, recording.filename);
    if (
      fs.existsSync(target) &&
      sha256(fs.readFileSync(target)) !== recording.sha256
    )
      throw new Error(
        `Existing recording differs; refusing to overwrite ${recording.filename}`,
      );
  }
  fs.mkdirSync(path.join(path.resolve(directory), "originals"), {
    recursive: true,
  });
  let imported = 0;
  for (const recording of recordings) {
    const target = original_path(directory, recording.filename);
    if (fs.existsSync(target)) continue;
    const bytes = read_git(source_repo, [
      "show",
      `${resolved_commit}:${recording.source.path}`,
    ]);
    if (sha256(bytes) !== recording.sha256)
      throw new Error("Source changed during import.");
    fs.writeFileSync(target, bytes, { flag: "wx" });
    imported++;
  }
  if (!fs.existsSync(catalog_path))
    fs.writeFileSync(catalog_path, JSON.stringify(catalog, null, 2) + "\n", {
      flag: "wx",
    });
  return {
    ...verify_library(directory, { include_playback: false }),
    imported,
  };
}

export function verify_library(directory, { include_playback = true } = {}) {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(path.resolve(directory), "catalog.json"), "utf8"),
  );
  const recordings = validate_catalog(catalog);
  let bytes = 0;
  for (const recording of recordings) {
    const content = fs.readFileSync(
      original_path(directory, recording.filename),
    );
    if (
      content.length !== recording.bytes ||
      sha256(content) !== recording.sha256
    )
      throw new Error(`Integrity check failed: ${recording.filename}`);
    bytes += content.length;
  }
  return {
    instruments: catalog.instruments.length,
    recordings: recordings.length,
    bytes,
    integrity_verified: true,
    ...verify_indexes(directory, catalog),
    ...(include_playback
      ? verify_playback(directory, catalog)
      : { playback_assets_verified: false }),
    playback_enabled: catalog.instruments.filter(
      (instrument) => instrument.enabled,
    ).length,
  };
}
