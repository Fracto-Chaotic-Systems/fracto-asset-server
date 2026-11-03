import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function prepared_kit(
  base,
  { bad_gap = false, silent = false, bad_edge = false } = {},
) {
  const kit = structuredClone(base);
  const config = {
    sample_rate: 48000,
    max_hit_seconds: 30,
    note_off_seconds: 0.1,
    gain: 0.2,
    interpolation: 7,
    reverb: false,
    chorus: false,
    cpu_cores: 1,
  };
  const config_json = JSON.stringify(config, null, 2) + "\n",
    config_sha256 = hash(config_json);
  const frames = kit.notes.length * 4 + (kit.notes.length - 1) * 2400,
    content = Buffer.alloc(44 + frames * 2);
  content.write("RIFF");
  content.writeUInt32LE(content.length - 8, 4);
  content.write("WAVEfmt ", 8);
  content.writeUInt32LE(16, 16);
  content.writeUInt16LE(1, 20);
  content.writeUInt16LE(1, 22);
  content.writeUInt32LE(48000, 24);
  content.writeUInt32LE(96000, 28);
  content.writeUInt16LE(2, 32);
  content.writeUInt16LE(16, 34);
  content.write("data", 36);
  content.writeUInt32LE(frames * 2, 40);
  const hits = kit.notes.map((note, i) => {
    const offset_frames = i * 2404;
    content.writeInt16LE(silent ? 0 : 100, 44 + (offset_frames + 1) * 2);
    content.writeInt16LE(silent ? 0 : 100, 44 + (offset_frames + 2) * 2);
    if (bad_edge) content.writeInt16LE(1, 44 + (offset_frames + 3) * 2);
    return {
      midi_note: note.midi_note,
      velocity_min: 1,
      velocity_max: 127,
      render_velocity: 127,
      offset_frames,
      frames: 4,
      offset_seconds: offset_frames / 48000,
      duration_seconds: 4 / 48000,
      pcm_sha256: hash(
        content.subarray(44 + offset_frames * 2, 44 + (offset_frames + 4) * 2),
      ),
    };
  });
  if (bad_gap) content.writeInt16LE(1, 44 + 4 * 2);
  const sha256 = hash(content);
  const asset = {
    id: `${kit.id}-${config_sha256.slice(0, 12)}-chunk-0`,
    method_version: "sf2-drum-hits-pcm16-v1",
    path: `playback/${kit.id}/${sha256}.wav`,
    sha256,
    bytes: content.length,
    mime_type: "audio/wav",
    encoding: "pcm_s16le",
    sample_rate: 48000,
    channels: 1,
    frames,
    duration_seconds: frames / 48000,
    decoded_bytes_at_48000: frames * 4,
    source_sha256: kit.source_sha256,
    render_config_sha256: config_sha256,
    hits,
  };
  const manifest = {
    schema_version: 1,
    method_version: asset.method_version,
    kit_id: kit.id,
    source_sha256: kit.source_sha256,
    config,
    config_json,
    config_sha256,
    renderer_lock_sha256: "d".repeat(64),
    renderer_version: "2.6.2",
    assets: [asset],
    hits: hits.map((hit) => ({
      ...hit,
      metrics: {
        rendered_frames: 20000,
        trim_start_frame: 0,
        trim_end_frame: 4,
        rendered_stereo_sha256: "e".repeat(64),
        stereo_peak: 0.1,
        mono_peak: 0.1,
        quantization_max_error: 0,
      },
    })),
  };
  const manifest_bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  kit.verification_status = "assets_prepared";
  kit.playback_assets = [asset];
  kit.rendering = {
    method_version: asset.method_version,
    manifest_path: `indexes/${kit.id}-${config_sha256.slice(0, 12)}-render.json`,
    manifest_sha256: hash(manifest_bytes),
    config_sha256,
    renderer_lock_sha256: manifest.renderer_lock_sha256,
    renderer_version: "2.6.2",
  };
  return {
    kit,
    content,
    manifest_bytes,
    totals: {
      method_version: asset.method_version,
      asset_count: 1,
      hit_count: hits.length,
      encoded_bytes: content.length,
      largest_decoded_bytes_at_48000: frames * 4,
    },
  };
}
