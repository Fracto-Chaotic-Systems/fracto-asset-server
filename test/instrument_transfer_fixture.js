import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { transfer_hash } from "../../../utils/instrument_transfer.js";

export function transfer_fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-instrument-preview-"),
  );
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("fracto-instrument-preview-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (relative, bytes) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), bytes);
  };
  const original = Buffer.from("ID3 original fixture");
  const audio = Buffer.alloc(64);
  audio.write("RIFF");
  audio.writeUInt32LE(56, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(48000, 24);
  audio.writeUInt32LE(96000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(20, 40);
  const recording = {
    id: "piano-main",
    filename: "piano.mp3",
    path: "originals/piano.mp3",
    sha256: transfer_hash(original),
    bytes: original.length,
    mime_type: "audio/mpeg",
  };
  const asset = {
    id: "piano-chunk",
    recording_id: recording.id,
    path: `playback/${recording.id}/${transfer_hash(audio)}.wav`,
    bytes: audio.length,
    sha256: transfer_hash(audio),
    method_version: "mono-octave-pcm16-v1",
  };
  const catalog = {
    schema_version: 1,
    library_version: 1,
    instruments: [
      {
        id: "piano",
        name: "Piano",
        enabled: false,
        pitch_map: null,
        recordings: [recording],
        playback_assets: [asset],
      },
    ],
  };
  write(recording.path, original);
  write(asset.path, audio);
  const save = () => write("catalog.json", JSON.stringify(catalog));
  save();
  return { root, write, catalog, save, recording, asset };
}

export function add_transfer_index(fixture) {
  const recording = fixture.catalog.instruments[0].recordings[0];
  const index = {
    schema_version: 1,
    method_version: "chromatic-index-v1",
    recording_id: recording.id,
    source_sha256: recording.sha256,
    sample_rate: 1000,
    channels: 2,
    frames: 410000,
    duration_seconds: 410,
    grid: { slot_seconds: 10, zero_pitch: 20 },
    notes: [
      {
        midi_pitch: 60,
        nominal_seconds: 400,
        offset_seconds: 399.99,
        onset_seconds: 400,
        tail_end_seconds: 400.08,
        end_seconds: 400.09,
        duration_seconds: 0.1,
        pitch_evidence: { matching_windows: 2 },
      },
    ],
    excluded: Array.from({ length: 128 }, (_, midi_pitch) => ({
      midi_pitch,
      reason: "fixture",
    })).filter((note) => note.midi_pitch !== 60),
  };
  const content = JSON.stringify(index),
    relative = `indexes/${recording.id}.json`,
    sha256 = transfer_hash(content);
  recording.timing = {
    method_version: index.method_version,
    index_path: relative,
    index_sha256: sha256,
    slot_seconds: 10,
    zero_pitch: 20,
    duration_seconds: 410,
    sample_rate: 1000,
    channels: 2,
    available_pitches: [60],
  };
  fixture.catalog.instruments[0].pitch_map = {
    type: "recording_indexes",
    indexes: [{ recording_id: recording.id, path: relative, sha256 }],
    available_pitches: [60],
    common_pitches: [60],
  };
  fixture.write(relative, content);
  fixture.save();
  return relative;
}

// A fully verified, non-silent PCM source/index mapping for publication tests.
export function publication_fixture(t) {
  const fixture = transfer_fixture(t);
  add_transfer_index(fixture);
  const recording = fixture.catalog.instruments[0].recordings[0];
  recording.velocity_layer = null;
  const audio = Buffer.alloc(244);
  audio.write("RIFF");
  audio.writeUInt32LE(236, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(1000, 24);
  audio.writeUInt32LE(2000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(200, 40);
  for (let frame = 1; frame < 99; frame++)
    audio.writeInt16LE(1000, 44 + frame * 2);
  Object.assign(fixture.asset, {
    sha256: transfer_hash(audio),
    bytes: audio.length,
    path: `playback/${recording.id}/${transfer_hash(audio)}.wav`,
    source_sha256: recording.sha256,
    index_sha256: recording.timing.index_sha256,
    velocity_layer: null,
    encoding: "pcm_s16le",
    mime_type: "audio/wav",
    channels: 1,
    sample_rate: 1000,
    frames: 100,
    decoded_bytes_at_48000: 19200,
    duration_seconds: 0.1,
    notes: [
      {
        midi_pitch: 60,
        source_start_frame: 399990,
        source_end_frame: 400090,
        offset_frames: 0,
        frames: 100,
        onset_frame: 10,
        offset_seconds: 0,
        duration_seconds: 0.1,
      },
    ],
  });
  Object.assign(fixture.catalog.instruments[0], {
    kind: "single",
    enabled: true,
    verification_status: "playback_verified",
    midi_programs: [0],
    banks: [],
  });
  fixture.write(fixture.asset.path, audio);
  fixture.save();
  return fixture;
}
