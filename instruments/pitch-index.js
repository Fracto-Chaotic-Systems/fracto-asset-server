import { validate_note_sample_index } from "./note-sample-index.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const fail = (message) => {
  throw new Error(`Invalid pitch index: ${message}`);
};

export function validate_pitch_index(index, recording) {
  if (index.method_version === "fluidr3-note-samples-v1")
    return validate_note_sample_index(index, recording);
  const timing = recording.timing;
  if (
    !timing ||
    index.schema_version !== 1 ||
    index.method_version !== timing.method_version ||
    index.recording_id !== recording.id ||
    index.source_sha256 !== recording.sha256
  )
    fail("source or method mismatch");
  if (
    ![10, 20].includes(index.grid?.slot_seconds) ||
    index.grid.zero_pitch !== 20 ||
    index.grid.slot_seconds !== timing.slot_seconds ||
    timing.zero_pitch !== 20 ||
    !Number.isInteger(index.sample_rate) ||
    index.sample_rate <= 0 ||
    !Number.isInteger(index.channels) ||
    index.channels < 1 ||
    !Number.isInteger(index.frames) ||
    index.frames < 1 ||
    !finite(index.duration_seconds) ||
    Math.abs(index.duration_seconds - index.frames / index.sample_rate) >
      1e-6 ||
    index.duration_seconds !== timing.duration_seconds ||
    index.sample_rate !== timing.sample_rate ||
    index.channels !== timing.channels
  )
    fail("invalid recording dimensions or timing grid");
  if (
    !Array.isArray(index.notes) ||
    !index.notes.length ||
    !Array.isArray(index.excluded)
  )
    fail("missing note coverage");
  const pitches = [],
    covered = new Set();
  let previous_end = -Infinity;
  for (const note of index.notes) {
    const pitch = note.midi_pitch;
    if (
      !Number.isInteger(pitch) ||
      pitch < 0 ||
      pitch > 127 ||
      covered.has(pitch) ||
      (pitches.length && pitch <= pitches.at(-1))
    )
      fail("duplicate or unordered pitches");
    covered.add(pitch);
    pitches.push(pitch);
    const nominal = index.grid.slot_seconds * (pitch - index.grid.zero_pitch);
    const times = [
      "nominal_seconds",
      "offset_seconds",
      "onset_seconds",
      "tail_end_seconds",
      "end_seconds",
      "duration_seconds",
    ];
    if (
      !times.every((key) => finite(note[key])) ||
      note.nominal_seconds !== nominal ||
      note.offset_seconds < 0 ||
      note.offset_seconds > note.onset_seconds ||
      note.onset_seconds > note.tail_end_seconds ||
      note.tail_end_seconds > note.end_seconds ||
      note.end_seconds <= note.offset_seconds ||
      note.end_seconds > index.duration_seconds + 1e-6 ||
      note.offset_seconds < nominal - 0.300001 ||
      note.end_seconds > nominal + index.grid.slot_seconds - 0.299999 ||
      note.offset_seconds < previous_end ||
      Math.abs(
        note.duration_seconds - (note.end_seconds - note.offset_seconds),
      ) > 2e-6
    )
      fail(`unsafe note bounds for pitch ${pitch}`);
    if (
      !Number.isInteger(note.pitch_evidence?.matching_windows) ||
      note.pitch_evidence.matching_windows < 2
    )
      fail(`insufficient pitch evidence for ${pitch}`);
    previous_end = note.end_seconds;
  }
  for (const entry of index.excluded) {
    if (
      !Number.isInteger(entry.midi_pitch) ||
      entry.midi_pitch < 0 ||
      entry.midi_pitch > 127 ||
      covered.has(entry.midi_pitch) ||
      !entry.reason
    )
      fail("invalid excluded pitch");
    covered.add(entry.midi_pitch);
  }
  if (covered.size !== 128 || !same(pitches, timing.available_pitches))
    fail("pitch coverage differs from catalog");
  return pitches;
}

export function verify_indexes(directory, catalog) {
  let indexed_recordings = 0,
    indexed_notes = 0;
  for (const instrument of catalog.instruments) {
    const references = [],
      pitch_sets = [];
    for (const recording of instrument.recordings) {
      if (!recording.timing) continue;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(recording.id))
        fail("invalid recording ID");
      const relative = `indexes/${recording.id}.json`;
      if (recording.timing.index_path !== relative) fail("invalid index path");
      const filename = path.join(path.resolve(directory), relative);
      if (
        fs.lstatSync(path.dirname(filename)).isSymbolicLink() ||
        fs.lstatSync(filename).isSymbolicLink()
      )
        fail("index paths must not be symbolic links");
      const content = fs.readFileSync(filename),
        sha256 = checksum(content);
      if (sha256 !== recording.timing.index_sha256)
        fail("index checksum mismatch");
      const pitches = validate_pitch_index(JSON.parse(content), recording);
      pitch_sets.push(new Set(pitches));
      references.push({ recording_id: recording.id, path: relative, sha256 });
      indexed_recordings++;
      indexed_notes += pitches.length;
    }
    if (!references.length) {
      if (instrument.pitch_map !== null) fail("pitch map without indexes");
      continue;
    }
    const available = [
      ...new Set(pitch_sets.flatMap((pitches) => [...pitches])),
    ].sort((a, b) => a - b);
    const common = [...pitch_sets[0]]
      .filter((pitch) => pitch_sets.every((pitches) => pitches.has(pitch)))
      .sort((a, b) => a - b);
    if (
      references.length !== instrument.recordings.length ||
      instrument.pitch_map?.type !== "recording_indexes" ||
      !same(instrument.pitch_map.indexes, references) ||
      !same(instrument.pitch_map.available_pitches, available) ||
      !same(instrument.pitch_map.common_pitches, common)
    )
      fail("instrument pitch map mismatch");
  }
  return { indexed_recordings, indexed_notes };
}
