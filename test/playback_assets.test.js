import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  read_pcm_wav,
  validate_playback_asset,
} from "../instruments/playback-assets.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function wav(frames = 100) {
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(1000, 24);
  bytes.writeUInt32LE(2000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 1; frame < frames - 1; frame++)
    bytes.writeInt16LE(1000, 44 + frame * 2);
  return bytes;
}
function fixture() {
  const content = wav();
  const recording = {
    id: "test-main",
    sha256: "a".repeat(64),
    velocity_layer: null,
    timing: { index_sha256: "b".repeat(64) },
  };
  const index = {
    sample_rate: 1000,
    notes: [
      {
        midi_pitch: 60,
        offset_seconds: 400,
        end_seconds: 400.1,
        onset_seconds: 400.02,
        tail_guarded: false,
      },
    ],
  };
  const asset = {
    id: "test-main-chunk-0",
    recording_id: recording.id,
    source_sha256: recording.sha256,
    index_sha256: recording.timing.index_sha256,
    velocity_layer: null,
    method_version: "mono-octave-pcm16-v1",
    encoding: "pcm_s16le",
    mime_type: "audio/wav",
    channels: 1,
    sample_rate: 1000,
    frames: 100,
    bytes: content.length,
    sha256: hash(content),
    decoded_bytes_at_48000: 19200,
    duration_seconds: 0.1,
    notes: [
      {
        midi_pitch: 60,
        source_start_frame: 400000,
        source_end_frame: 400100,
        offset_frames: 0,
        frames: 100,
        onset_frame: 20,
        offset_seconds: 0,
        duration_seconds: 0.1,
        tail_guarded: false,
      },
    ],
  };
  return { content, recording, index, asset };
}
test("canonical PCM WAV and mapping validate at exact frame boundaries", () => {
  const { asset, recording, index, content } = fixture();
  assert.equal(read_pcm_wav(content).frames, 100);
  assert.equal(
    validate_playback_asset(asset, recording, index, content),
    19200,
  );
});
test("tampering, wrong source windows and inconsistent timing are rejected", () => {
  for (const mutate of [
    (f) => (f.content[80] ^= 1),
    (f) => (f.asset.source_sha256 = "c".repeat(64)),
    (f) => f.asset.notes[0].source_start_frame++,
    (f) => (f.asset.notes[0].duration_seconds = 0.2),
    (f) => (f.asset.notes[0].midi_pitch = 61),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => validate_playback_asset(f.asset, f.recording, f.index, f.content),
      /Invalid playback asset/,
    );
  }
});
test("boundary clicks, silent notes and invalid WAV formats fail readback", () => {
  for (const mutate of [
    (bytes) => bytes.writeInt16LE(1, 44),
    (bytes) => bytes.fill(0, 44),
    (bytes) => bytes.writeUInt16LE(2, 22),
  ]) {
    const f = fixture();
    mutate(f.content);
    f.asset.sha256 = hash(f.content);
    assert.throws(
      () => validate_playback_asset(f.asset, f.recording, f.index, f.content),
      /Invalid playback asset/,
    );
  }
});
test("oversized decoded chunks fail before any notes can be scheduled", () => {
  const f = fixture();
  f.content = wav(262145);
  f.asset.bytes = f.content.length;
  f.asset.sha256 = hash(f.content);
  f.asset.frames = 262145;
  f.asset.duration_seconds = 262.145;
  f.asset.decoded_bytes_at_48000 = 262145 * 48 * 4;
  assert.throws(
    () => validate_playback_asset(f.asset, f.recording, f.index, f.content),
    /decoded memory budget/,
  );
});
