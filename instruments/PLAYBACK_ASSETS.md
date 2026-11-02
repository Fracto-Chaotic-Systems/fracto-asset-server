# Bounded playback assets

Current playback status (2026-11-02): **all 21 instruments are enabled** after
75 native Chromium decode/render probes (low/middle/high pitches of every
recording layer) passed through the sample cache and voice engine at 48 kHz.
The catalog marks them playback_verified; detailed evidence is recorded in
browser-verification.json in the asset-server instruments directory. Earlier
disabled/pending statements below describe the initial migration stages.
Native probes confirm signal output, not a subjective listening review.
Reload All Music to fetch the updated catalog. A source can still be disabled
for a track containing notes outside that instrument's verified pitch range.


Prepared 2026-11-02. Catalog library version 3 contains 183 mono playback
chunks covering all 1,999 indexed pitch windows from the 25 original recordings.
Original MP3s and verified indexes are unchanged. Every instrument remains disabled;
HTTP delivery, engine integration and instrument assignment are implemented.
See [MIGRATION_VERIFICATION.md](MIGRATION_VERIFICATION.md) for current evidence.

## Format and layout

- Canonical mono 16-bit little-endian PCM WAV at the original 44.1kHz rate.
  WAV avoids an additional MP3 encode/decode padding offset. Mono is the arithmetic
  mean of both original channels; no per-note normalization or layer gain changes
  are applied. Non-finite input and peaks above full scale fail instead of clipping.
- Each asset contains at most one MIDI octave and at most 12 notes. A chunk is
  split further if necessary to stay below 48 MiB decoded at 48kHz. The largest
  current chunk is 40.49 MiB at that rate.
- Only verified source windows are copied. Notes retain their 20ms pre-roll.
  Every window gets a 2ms fade-in and 20ms fade-out, including the two piano
  windows whose tails reach the next-slot guard. First and last samples are zero.
- Adjacent note windows are separated by 50ms of exact digital silence.
  Offsets and lengths are explicit: a player must stop each voice at that note's
  duration, rather than using the entire chunk as its sustain limit.
- Paths are content-addressed `playback/<recording-id>/<sha256>.wav`.
  Asset IDs are stable per recording/chunk; the SHA identifies actual content.
  Rebuilding identical files reuses them; a differing file at a hash path fails.

## Catalog contract

`instrument.playback_assets` contains asset ID, recording/layer identity, source
and index checksums, generated checksum/byte length, encoding, sample rate, frames,
duration and decoded bytes at 48kHz. Each asset lists its notes with:

- MIDI pitch and original source start/end frames.
- Chunk-relative offset/length in frames and seconds, and chunk onset frame.
- Whether the source tail reached the next-slot guard.

Frame fields use the WAV sample rate; `offset_seconds` / `duration_seconds` are
appropriate when a browser resamples to a different AudioContext rate. Runtime
memory accounting must use the actual decoded AudioBuffer dimensions. A 48 MiB
per-asset bound does not guarantee that every multi-instrument song fits the
current aggregate 256 MiB cache; the player enforces that aggregate bound before fetching.

The existing index-based `pitch_map` is preserved for provenance and verification.
The on-disk catalog stores registered relative asset paths; GET /instruments
projects those into versioned HTTP URLs without exposing disk paths. `verification_status` is
`assets_prepared`; original recordings retain `indexing_verified` and
`enabled` stays false pending per-source playback verification and enablement.

## Reproduce and verify

Use the same Python environment/dependencies as [INDEX_VERIFICATION.md](INDEX_VERIFICATION.md):

```powershell
# Preview without changing assets/catalog:
.\.venv\Scripts\python.exe scripts/prepare_instrument_assets.py
# Generate/reuse content-addressed files and publish metadata:
.\.venv\Scripts\python.exe scripts/prepare_instrument_assets.py --apply
npm run instruments:verify
# Independently compare every generated note interior to the indexed originals:
.\.venv\Scripts\python.exe scripts/verify_instrument_assets.py --output instruments/playback-verification.json
.\.venv\Scripts\python.exe test/instrument_playback_assets_test.py
npm run test:instruments
```

Both Python commands accept `--library-dir PATH`. Generation preflights original
and index integrity using `verify --sources-only`, allowing missing generated
assets to be rebuilt. Default verification checks originals, indexes AND playback.
The generator only publishes the catalog after every chunk passes PCM readback.
An interrupted run may leave unreferenced content files; rerun reuses them.
If interrupted during a file write, the conflicting hash-path file is reported;
no existing file is silently overwritten and no automatic cleanup is performed.

The large `instruments/playback/` directory is ignored local storage, like
`originals/`. Current WAV storage is 1,370,601,654 bytes (1.28 GiB).
The tracked catalog and scripts allow regeneration; a Git checkout alone does
not include audio. Persistent deployment storage remains a later migration step.

## Validation

The Node verifier checks every WAV checksum/header, source/index identity, exact
coverage, frame/time mappings, octave boundaries, decoded-size budget, fade
endpoints and silent gaps. Python independently reads every written chunk and
compares all note interiors against the indexed original stereo-average samples;
only intentional fade regions are excluded. Differences must stay within one
PCM16 quantization step. See `playback-verification.json` for measured results.

Browser decoding, audible playback and the player's use of these sources are
not claimed by asset preparation. Endpoint authentication/CORS is now tested
separately in [HTTP_API.md](HTTP_API.md).

Measured validation: 13 Node tests and 11 Python tests pass. Every one of the
183 output assets and 1,999 note interiors passed source alignment checks.
Maximum absolute PCM difference was 1.52587890625e-05 (half a PCM16
quantization step), outside intentional fades. Syntax, formatting and diff checks pass.

A repeat preparation run generated zero files, reused all 183 chunks and
preserved the catalog byte-for-byte. Total generated storage is 1,370,601,654
bytes; the original 407,310,721 bytes and all pitch indexes remain unchanged.
