import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (message) => {
  throw new Error(`Invalid playback asset: ${message}`);
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);
export const MAX_PLAYBACK_DECODED_BYTES = 48 * 1024 * 1024;

export function read_pcm_wav(content) {
  if (
    content.length < 44 ||
    content.toString("ascii", 0, 4) !== "RIFF" ||
    content.readUInt32LE(4) !== content.length - 8 ||
    content.toString("ascii", 8, 16) !== "WAVEfmt " ||
    content.readUInt32LE(16) !== 16 ||
    content.readUInt16LE(20) !== 1 ||
    content.readUInt16LE(22) !== 1 ||
    content.readUInt16LE(32) !== 2 ||
    content.readUInt16LE(34) !== 16 ||
    content.toString("ascii", 36, 40) !== "data" ||
    content.readUInt32LE(40) !== content.length - 44 ||
    (content.length - 44) % 2
  )
    fail("expected canonical mono PCM16 WAV");
  const rate = content.readUInt32LE(24);
  if (!rate || content.readUInt32LE(28) !== rate * 2)
    fail("invalid WAV sample rate");
  return {
    sample_rate: rate,
    frames: (content.length - 44) / 2,
    pcm: new Int16Array(
      content.buffer,
      content.byteOffset + 44,
      (content.length - 44) / 2,
    ),
  };
}

export function validate_playback_asset(asset, recording, index, content) {
  if (
    asset.method_version !== "mono-octave-pcm16-v1" ||
    asset.source_sha256 !== recording.sha256 ||
    asset.recording_id !== recording.id ||
    asset.index_sha256 !== recording.timing.index_sha256 ||
    asset.velocity_layer !== recording.velocity_layer ||
    asset.encoding !== "pcm_s16le" ||
    asset.mime_type !== "audio/wav" ||
    asset.channels !== 1 ||
    asset.bytes !== content.length ||
    hash(content) !== asset.sha256
  )
    fail("source, encoding or checksum mismatch");
  const wav = read_pcm_wav(content);
  const decoded = Math.ceil((wav.frames * 48000) / wav.sample_rate) * 4;
  if (
    wav.sample_rate !== index.sample_rate ||
    asset.sample_rate !== wav.sample_rate ||
    asset.frames !== wav.frames ||
    asset.decoded_bytes_at_48000 !== decoded ||
    decoded > MAX_PLAYBACK_DECODED_BYTES ||
    !finite(asset.duration_seconds) ||
    Math.abs(asset.duration_seconds - wav.frames / wav.sample_rate) > 1e-8 ||
    !Array.isArray(asset.notes) ||
    !asset.notes.length ||
    asset.notes.length > 12
  )
    fail("invalid dimensions or decoded memory budget");
  const indexed = new Map(index.notes.map((note) => [note.midi_pitch, note]));
  let cursor = 0,
    last_pitch = -1;
  const octave = Math.floor(asset.notes[0].midi_pitch / 12);
  for (const note of asset.notes) {
    const source = indexed.get(note.midi_pitch);
    if (
      !source ||
      note.midi_pitch <= last_pitch ||
      Math.floor(note.midi_pitch / 12) !== octave
    )
      fail("unknown, unordered or mixed-octave pitches");
    const start = Math.round(source.offset_seconds * wav.sample_rate),
      end = Math.round(source.end_seconds * wav.sample_rate);
    const expected_offset =
      cursor + (cursor ? Math.round(0.05 * wav.sample_rate) : 0);
    if (
      note.source_start_frame !== start ||
      note.source_end_frame !== end ||
      note.frames !== end - start ||
      note.offset_frames !== expected_offset ||
      note.onset_frame !==
        expected_offset +
          Math.round(source.onset_seconds * wav.sample_rate) -
          start ||
      note.tail_guarded !== source.tail_guarded ||
      !finite(note.offset_seconds) ||
      Math.abs(note.offset_seconds - expected_offset / wav.sample_rate) >
        1e-8 ||
      !finite(note.duration_seconds) ||
      Math.abs(note.duration_seconds - note.frames / wav.sample_rate) > 1e-8 ||
      note.offset_frames + note.frames > wav.frames
    )
      fail("note mapping differs from verified source window");
    if (
      wav.pcm[note.offset_frames] !== 0 ||
      wav.pcm[note.offset_frames + note.frames - 1] !== 0 ||
      !wav.pcm
        .subarray(note.offset_frames, note.offset_frames + note.frames)
        .some((sample) => sample !== 0) ||
      wav.pcm
        .subarray(cursor, note.offset_frames)
        .some((sample) => sample !== 0)
    )
      fail("silent note or missing fade/silence guard");
    cursor = note.offset_frames + note.frames;
    last_pitch = note.midi_pitch;
  }
  if (cursor !== wav.frames) fail("unmapped trailing audio");
  return decoded;
}

export function verify_playback(directory, catalog) {
  let count = 0,
    notes = 0,
    bytes = 0,
    largest = 0;
  const ids = new Set();
  for (const instrument of catalog.instruments) {
    const assets = instrument.playback_assets ?? [];
    if (!assets.length) continue;
    const recordings = new Map(
      instrument.recordings.map((recording) => [recording.id, recording]),
    );
    const seen = new Map([...recordings.keys()].map((id) => [id, []]));
    const indexes = new Map(
      [...recordings.values()].map((recording) => [
        recording.id,
        JSON.parse(
          fs.readFileSync(
            path.join(directory, recording.timing.index_path),
            "utf8",
          ),
        ),
      ]),
    );
    for (const asset of assets) {
      const recording = recordings.get(asset.recording_id);
      if (
        !recording ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.id) ||
        ids.has(asset.id) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        asset.path !== `playback/${recording.id}/${asset.sha256}.wav`
      )
        fail("duplicate ID or invalid asset path");
      ids.add(asset.id);
      // Distinct octave mappings may reference identical, checksum-addressed audio.
      const target = path.join(path.resolve(directory), asset.path);
      for (const entry of [
        path.join(directory, "playback"),
        path.dirname(target),
        target,
      ])
        if (fs.lstatSync(entry).isSymbolicLink())
          fail("symbolic links are not asset storage");
      const content = fs.readFileSync(target);
      const decoded = validate_playback_asset(
        asset,
        recording,
        indexes.get(recording.id),
        content,
      );
      seen
        .get(recording.id)
        .push(...asset.notes.map((note) => note.midi_pitch));
      count++;
      notes += asset.notes.length;
      bytes += content.length;
      largest = Math.max(largest, decoded);
    }
    for (const [id, pitches] of seen)
      if (
        !same(
          pitches,
          indexes.get(id).notes.map((note) => note.midi_pitch),
        )
      )
        fail("incomplete or duplicate recording coverage");
  }
  if (
    catalog.playback_preparation &&
    (catalog.playback_preparation.asset_count !== count ||
      catalog.playback_preparation.note_count !== notes ||
      catalog.playback_preparation.encoded_bytes !== bytes ||
      catalog.playback_preparation.largest_decoded_bytes_at_48000 !== largest)
  )
    fail("catalog preparation totals mismatch");
  return {
    playback_assets_verified: true,
    playback_assets: count,
    playback_notes: notes,
    playback_bytes: bytes,
    largest_decoded_bytes_at_48000: largest,
  };
}
