import test from "node:test";
import assert from "node:assert/strict";
import { validate_pitch_index } from "../instruments/pitch-index.js";
function fixture() {
  const index = {
    schema_version: 1,
    method_version: "fluidr3-note-samples-v1",
    recording_id: "fluidr3-gm-flute-main",
    source_sha256: "a".repeat(64),
    bundle_sha256: "b".repeat(64),
    sample_rate: 8000,
    channels: 1,
    frames: 1600,
    duration_seconds: 0.2,
    notes: [60, 61].map((midi_pitch, i) => ({
      midi_pitch,
      raw_start_frame: i * 800,
      raw_end_frame: (i + 1) * 800,
      nominal_seconds: i * 0.1,
      offset_seconds: i * 0.1 + 0.005,
      onset_seconds: i * 0.1 + 0.025,
      end_seconds: (i + 1) * 0.1,
      tail_end_seconds: (i + 1) * 0.1,
      duration_seconds: 0.095,
      tail_guarded: false,
      source_sample: {
        name: i ? "Db4" : "C4",
        sha256: "c".repeat(64),
        frames: 800,
        sample_rate: 8000,
        channels: 2,
      },
    })),
    excluded: Array.from({ length: 88 }, (_, i) => i + 21)
      .filter((p) => ![60, 61].includes(p))
      .map((midi_pitch) => ({
        midi_pitch,
        reason: "silent_source",
        source_sha256: "d".repeat(64),
      })),
  };
  const recording = {
    id: index.recording_id,
    sha256: index.source_sha256,
    mime_type: "audio/wav",
    source: { kind: "midi-js-note-mp3", bundle_sha256: index.bundle_sha256 },
    timing: {
      method_version: index.method_version,
      sample_rate: 8000,
      channels: 1,
      frames: 1600,
      duration_seconds: 0.2,
      available_pitches: [60, 61],
    },
  };
  return { index, recording };
}
test("discrete-note source indexes retain sparse coverage and canonical source boundaries", () => {
  const { index, recording } = fixture();
  assert.deepEqual(validate_pitch_index(index, recording), [60, 61]);
});
test("note source hash, identity, windows and excluded inventory are verified", () => {
  const mutations = [
    (i, r) => (r.source.bundle_sha256 = "e".repeat(64)),
    (i) => (i.notes[0].source_sample.name = "D4"),
    (i) => (i.notes[0].offset_seconds = -1),
    (i) => (i.notes[0].end_seconds = 0.11),
    (i) => (i.notes[1].raw_start_frame = 799),
    (i) => i.excluded.pop(),
    (i) => i.excluded.push({ ...i.excluded[0] }),
    (i) => (i.notes[0].duration_seconds = 0.2),
    (i) => (i.notes[0].source_sample.sha256 = "bad"),
    (i, r) => (r.timing.available_pitches = [60]),
  ];
  for (const mutate of mutations) {
    const { index, recording } = fixture();
    mutate(index, recording);
    assert.throws(() => validate_pitch_index(index, recording));
  }
});
