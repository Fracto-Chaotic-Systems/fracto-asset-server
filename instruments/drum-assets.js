import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { validate_drum_assets } from "./catalog-libraries.js";
import { read_pcm_wav } from "./playback-assets.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = () => {
  throw new Error("Invalid prepared drum manifest or audio");
};

function read_safe(root, relative, max_bytes = 32 * 1024 * 1024) {
  const resolved = path.resolve(root),
    target = path.resolve(root, relative);
  if (!target.startsWith(resolved + path.sep)) fail();
  let current = resolved;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail();
  }
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > max_bytes) fail();
  return fs.readFileSync(target);
}

export function verify_drum_manifests(directory, catalog) {
  let count = 0;
  for (const kit of catalog.drum_kits ?? []) {
    if (kit.verification_status === "source_audited") continue;
    validate_drum_assets(kit);
    const rendering = kit.rendering;
    if (
      rendering.manifest_path !==
        `indexes/${kit.id}-${rendering.config_sha256.slice(0, 12)}-render.json` ||
      !/^[a-f0-9]{64}$/.test(rendering.manifest_sha256 ?? "")
    )
      fail();
    const content = read_safe(
      directory,
      rendering.manifest_path,
      16 * 1024 * 1024,
    );
    if (
      content.length > 16 * 1024 * 1024 ||
      hash(content) !== rendering.manifest_sha256
    )
      fail();
    const manifest = JSON.parse(content);
    if (
      manifest.schema_version !== 1 ||
      manifest.kit_id !== kit.id ||
      manifest.method_version !== rendering.method_version ||
      manifest.source_sha256 !== kit.source_sha256 ||
      manifest.config_sha256 !== rendering.config_sha256 ||
      manifest.renderer_lock_sha256 !== rendering.renderer_lock_sha256 ||
      manifest.renderer_version !== rendering.renderer_version ||
      typeof manifest.config_json !== "string" ||
      hash(Buffer.from(manifest.config_json)) !== rendering.config_sha256 ||
      !same(JSON.parse(manifest.config_json), manifest.config) ||
      !same(manifest.assets, kit.playback_assets)
    )
      fail();
    const config = manifest.config;
    if (
      config.sample_rate !== 48000 ||
      config.max_hit_seconds !== 30 ||
      config.note_off_seconds !== 0.1 ||
      config.gain !== 0.2 ||
      config.interpolation !== 7 ||
      config.reverb !== false ||
      config.chorus !== false ||
      config.cpu_cores !== 1 ||
      !Array.isArray(manifest.hits)
    )
      fail();
    const hits = kit.playback_assets.flatMap((asset) => asset.hits);
    if (hits.length !== manifest.hits.length) fail();
    for (const [index, hit] of hits.entries()) {
      const proof = manifest.hits[index],
        m = proof.metrics;
      for (const key of [
        "midi_note",
        "velocity_min",
        "velocity_max",
        "render_velocity",
        "frames",
        "pcm_sha256",
      ])
        if (proof[key] !== hit[key]) fail();
      if (
        !m ||
        !Number.isSafeInteger(m.rendered_frames) ||
        m.rendered_frames > 30 * 48000 ||
        !Number.isSafeInteger(m.trim_start_frame) ||
        m.trim_start_frame < 0 ||
        !Number.isSafeInteger(m.trim_end_frame) ||
        m.trim_end_frame > m.rendered_frames ||
        m.trim_end_frame - m.trim_start_frame !== hit.frames ||
        !/^[a-f0-9]{64}$/.test(m.rendered_stereo_sha256 ?? "") ||
        !Number.isFinite(m.stereo_peak) ||
        m.stereo_peak <= 0 ||
        m.stereo_peak > 1 ||
        !Number.isFinite(m.mono_peak) ||
        m.mono_peak <= 0 ||
        m.mono_peak > 1 ||
        !Number.isFinite(m.quantization_max_error) ||
        m.quantization_max_error < 0 ||
        m.quantization_max_error > 1 / 32768
      )
        fail();
    }
    count++;
  }
  return count;
}

export function verify_drum_assets(directory, catalog) {
  const kits = verify_drum_manifests(directory, catalog);
  let assets = 0,
    hits = 0,
    bytes = 0,
    largest = 0;
  for (const kit of catalog.drum_kits ?? [])
    for (const asset of kit.playback_assets) {
      const content = read_safe(
        directory,
        `playback/${kit.id}/${asset.sha256}.wav`,
      );
      if (content.length !== asset.bytes || hash(content) !== asset.sha256)
        fail();
      const wav = read_pcm_wav(content);
      if (wav.sample_rate !== 48000 || wav.frames !== asset.frames) fail();
      let cursor = 0;
      for (const hit of asset.hits) {
        if (
          wav.pcm
            .subarray(cursor, hit.offset_frames)
            .some((value) => value !== 0)
        )
          fail();
        const start = 44 + hit.offset_frames * 2,
          end = start + hit.frames * 2;
        if (
          hash(content.subarray(start, end)) !== hit.pcm_sha256 ||
          !wav.pcm
            .subarray(hit.offset_frames, hit.offset_frames + hit.frames)
            .some((value) => value !== 0) ||
          wav.pcm[hit.offset_frames] !== 0 ||
          wav.pcm[hit.offset_frames + hit.frames - 1] !== 0
        )
          fail();
        cursor = hit.offset_frames + hit.frames;
        hits++;
      }
      assets++;
      bytes += content.length;
      largest = Math.max(largest, asset.decoded_bytes_at_48000);
    }
  const totals = catalog.percussion_preparation;
  if (
    assets &&
    (!totals ||
      totals.method_version !== "sf2-drum-hits-pcm16-v1" ||
      totals.asset_count !== assets ||
      totals.hit_count !== hits ||
      totals.encoded_bytes !== bytes ||
      totals.largest_decoded_bytes_at_48000 !== largest)
  )
    fail();
  return {
    prepared_drum_kits: kits,
    drum_playback_assets_verified: true,
    drum_playback_assets: assets,
    drum_hit_windows: hits,
    drum_playback_bytes: bytes,
    largest_drum_decoded_bytes_at_48000: largest,
  };
}
