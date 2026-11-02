import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  validate_pitch_index,
  verify_indexes,
} from "../instruments/pitch-index.js";

const fixture = () => {
  const recording = {
    id: "test-main",
    sha256: "a".repeat(64),
    timing: {
      method_version: "test-v1",
      slot_seconds: 10,
      zero_pitch: 20,
      duration_seconds: 410,
      sample_rate: 44100,
      channels: 1,
      available_pitches: [60],
    },
  };
  const index = {
    schema_version: 1,
    method_version: "test-v1",
    recording_id: "test-main",
    source_sha256: recording.sha256,
    grid: { slot_seconds: 10, zero_pitch: 20 },
    duration_seconds: 410,
    sample_rate: 44100,
    channels: 1,
    frames: 410 * 44100,
    notes: [
      {
        midi_pitch: 60,
        nominal_seconds: 400,
        offset_seconds: 399.99,
        onset_seconds: 400,
        tail_end_seconds: 400.9,
        end_seconds: 401,
        duration_seconds: 1.01,
        pitch_evidence: { matching_windows: 2 },
      },
    ],
    excluded: Array.from({ length: 128 }, (_, midi_pitch) => ({
      midi_pitch,
      reason: "no_reliable_pitch_evidence",
    })).filter((entry) => entry.midi_pitch !== 60),
  };
  return { index, recording };
};

test("index validates exact source identity, coverage and bounded note windows", () => {
  const { index, recording } = fixture();
  assert.deepEqual(validate_pitch_index(index, recording), [60]);
});

test("wrong source, decoder dimensions or grid cannot validate", () => {
  for (const mutate of [
    (index) => (index.source_sha256 = "b".repeat(64)),
    (index) => index.frames++,
    (index) => (index.grid.slot_seconds = 20),
  ]) {
    const { index, recording } = fixture();
    mutate(index);
    assert.throws(
      () => validate_pitch_index(index, recording),
      /Invalid pitch index/,
    );
  }
});

test("index rejects next-note bleed, reordered bounds, bad duration and weak evidence", () => {
  for (const mutate of [
    (note) => {
      note.end_seconds = 410;
      note.duration_seconds = 10.01;
    },
    (note) => (note.offset_seconds = 400.5),
    (note) => (note.duration_seconds = 5),
    (note) => (note.pitch_evidence.matching_windows = 1),
  ]) {
    const { index, recording } = fixture();
    mutate(index.notes[0]);
    assert.throws(
      () => validate_pitch_index(index, recording),
      /Invalid pitch index/,
    );
  }
});

test("duplicate, missing or inconsistent pitch coverage fails verification", () => {
  for (const mutate of [
    (index) => index.notes.push({ ...index.notes[0] }),
    (index) => index.excluded.pop(),
    (index) => index.excluded.push({ midi_pitch: 60, reason: "duplicate" }),
  ]) {
    const { index, recording } = fixture();
    mutate(index);
    assert.throws(
      () => validate_pitch_index(index, recording),
      /Invalid pitch index/,
    );
  }
  const { index, recording } = fixture();
  recording.timing.available_pitches = [61];
  assert.throws(() => validate_pitch_index(index, recording), /pitch coverage/);
});

test("index files are checksum-protected and catalog references must agree", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fracto-index-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("fracto-index-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "indexes"));
  const { index, recording } = fixture();
  const body = JSON.stringify(index),
    sha256 = createHash("sha256").update(body).digest("hex");
  const relative = "indexes/test-main.json",
    target = path.join(root, relative);
  fs.writeFileSync(target, body);
  Object.assign(recording.timing, {
    index_path: relative,
    index_sha256: sha256,
  });
  const catalog = {
    instruments: [
      {
        recordings: [recording],
        pitch_map: {
          type: "recording_indexes",
          indexes: [{ recording_id: recording.id, path: relative, sha256 }],
          available_pitches: [60],
          common_pitches: [60],
        },
      },
    ],
  };
  assert.deepEqual(verify_indexes(root, catalog), {
    indexed_recordings: 1,
    indexed_notes: 1,
  });
  fs.appendFileSync(target, " ");
  assert.throws(() => verify_indexes(root, catalog), /checksum mismatch/);
  fs.writeFileSync(target, body);
  catalog.instruments[0].pitch_map.common_pitches = [];
  assert.throws(() => verify_indexes(root, catalog), /pitch map mismatch/);
  catalog.instruments[0].pitch_map.common_pitches = [60];
  recording.timing.index_path = "../outside.json";
  assert.throws(() => verify_indexes(root, catalog), /invalid index path/);
});
