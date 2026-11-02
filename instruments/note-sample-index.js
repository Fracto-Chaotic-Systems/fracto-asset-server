const fail = (message) => {
  throw new Error(`Invalid note-sample index: ${message}`);
};
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6;
function pitch(name) {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(name ?? "");
  if (!match) fail("invalid note name");
  return (
    (Number(match[3]) + 1) * 12 +
    { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]] +
    { "": 0, "#": 1, b: -1 }[match[2]]
  );
}

export function validate_note_sample_index(index, recording) {
  const timing = recording.timing;
  if (
    index.schema_version !== 1 ||
    index.method_version !== "fluidr3-note-samples-v1" ||
    timing?.method_version !== index.method_version ||
    index.recording_id !== recording.id ||
    index.source_sha256 !== recording.sha256 ||
    recording.mime_type !== "audio/wav" ||
    recording.source?.kind !== "midi-js-note-mp3" ||
    !hash(index.bundle_sha256) ||
    index.bundle_sha256 !== recording.source.bundle_sha256
  )
    fail("source or method mismatch");
  if (
    !integer(index.sample_rate, 8000, 192000) ||
    index.channels !== 1 ||
    !integer(index.frames, 1) ||
    !near(index.duration_seconds, index.frames / index.sample_rate) ||
    index.sample_rate !== timing.sample_rate ||
    index.channels !== timing.channels ||
    index.duration_seconds !== timing.duration_seconds ||
    !Array.isArray(index.notes) ||
    !index.notes.length ||
    !Array.isArray(index.excluded)
  )
    fail("invalid dimensions");
  let cursor = 0,
    previous = -1;
  const covered = new Set(),
    pitches = [];
  for (const note of index.notes) {
    const original = note.source_sample;
    if (
      !integer(note.midi_pitch, 21, 108) ||
      note.midi_pitch <= previous ||
      !original ||
      pitch(original.name) !== note.midi_pitch ||
      !hash(original.sha256) ||
      !integer(original.frames, 1) ||
      original.sample_rate !== index.sample_rate ||
      !integer(original.channels, 1, 2) ||
      note.raw_start_frame !== cursor ||
      note.raw_end_frame !== cursor + original.frames
    )
      fail("invalid source sample");
    const start = Math.round(note.offset_seconds * index.sample_rate),
      end = Math.round(note.end_seconds * index.sample_rate),
      onset = Math.round(note.onset_seconds * index.sample_rate);
    if (
      !near(note.nominal_seconds, cursor / index.sample_rate) ||
      !integer(start, cursor, note.raw_end_frame - 1) ||
      end !== note.raw_end_frame ||
      !integer(onset, start, end - 1) ||
      start !==
        Math.max(cursor, onset - Math.round(0.02 * index.sample_rate)) ||
      !near(note.tail_end_seconds, note.end_seconds) ||
      !near(note.duration_seconds, (end - start) / index.sample_rate) ||
      note.tail_guarded !== false
    )
      fail("invalid note bounds");
    covered.add(note.midi_pitch);
    pitches.push(note.midi_pitch);
    previous = note.midi_pitch;
    cursor = note.raw_end_frame;
  }
  if (cursor !== index.frames) fail("unmapped source frames");
  for (const entry of index.excluded) {
    if (
      !integer(entry.midi_pitch, 21, 108) ||
      covered.has(entry.midi_pitch) ||
      entry.reason !== "silent_source" ||
      !hash(entry.source_sha256)
    )
      fail("invalid excluded pitch");
    covered.add(entry.midi_pitch);
  }
  if (covered.size !== 88) fail("incomplete source key inventory");
  if (JSON.stringify(timing.available_pitches) !== JSON.stringify(pitches))
    fail("timing coverage mismatch");
  return pitches;
}
