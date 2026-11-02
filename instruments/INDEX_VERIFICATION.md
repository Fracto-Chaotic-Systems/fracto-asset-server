# Pitch indexing verification

Verified 2026-11-02 using the checksum-pinned originals. All 25 recordings decoded
successfully; 1,999 pitch windows passed harmonic-spectrum and attack checks.
This is offline indexing verification, not browser playback verification.

## Timing layout

Every verified recording uses `slot_seconds * (midi_pitch - 20)`. GrandB has
20-second slots; all other recordings have 10-second slots. The slot size was
selected by comparing spectral evidence at MIDI 60, 69 and 72 under both grids;
at least two anchors must agree with a unique winning grid.

Available pitch coverage differs by recording. Every range below is contiguous;
the complete 0–127 coverage is partitioned into verified notes and explicit
exclusions. Silent slots and short non-pitched transients are excluded.

| Recording | Slot (s) | MIDI range | Notes | Max attack deviation (s) | Guarded tails |
| --- | ---: | --- | ---: | ---: | ---: |
| grandb-p | 20 | 21–108 | 88 | 0.04 | 0 |
| grandb-mp | 20 | 21–108 | 88 | 0.04 | 0 |
| grandb-mf | 20 | 21–108 | 88 | 0.03 | 0 |
| grandb-f | 20 | 21–108 | 88 | 0.03 | 0 |
| grandb-ff | 20 | 21–108 | 88 | 0.03 | 0 |
| acoustic-bass-main | 10 | 24–103 | 80 | 0.03 | 0 |
| blown-bottle-main | 10 | 24–104 | 81 | 0.04 | 0 |
| cello-main | 10 | 24–102 | 79 | 0.14 | 0 |
| chromatics-piano-main | 10 | 21–104 | 84 | 0.03 | 1 |
| distortion-guitar-main | 10 | 24–104 | 81 | 0.03 | 0 |
| flute-main | 10 | 24–104 | 81 | 0.08 | 0 |
| harmonica-main | 10 | 24–104 | 81 | 0.15 | 0 |
| harpsichord-main | 10 | 24–104 | 81 | 0.05 | 0 |
| piano-main | 10 | 21–104 | 84 | 0.03 | 1 |
| pipe-organ-main | 10 | 24–104 | 81 | 0.09 | 0 |
| vibraphone-main | 10 | 24–104 | 81 | 0.07 | 0 |
| violin-10-loud-main | 10 | 55–103 | 49 | 0.05 | 0 |
| violin-15-loud-main | 10 | 55–103 | 49 | 0.08 | 0 |
| acoustic-bass2-distortion-guitar1-pipe-organ1-main | 10 | 24–104 | 81 | 0.09 | 0 |
| cello4-vibraphone3-harpsichord1-main | 10 | 24–104 | 81 | 0.14 | 0 |
| distortion-guitar-pipe-organ-main | 10 | 24–104 | 81 | 0.09 | 0 |
| flute4-vibraphone3-harpsichord1-main | 10 | 24–104 | 81 | 0.07 | 0 |
| vibraphone-harpsichord-main | 10 | 24–104 | 81 | 0.05 | 0 |
| vibraphone2-distortion-guitar1-pipe-organ1-main | 10 | 24–104 | 81 | 0.09 | 0 |
| vibraphone3-harpsichord1-main | 10 | 24–104 | 81 | 0.05 | 0 |

## Measurement and playback boundaries

- Each indexed pitch needs spectral evidence in at least two of four probe
  windows. A strong fundamental or at least three coherent harmonics is
  accepted; an even-only harmonic series is rejected as an octave ambiguity.
- Spectral evidence uses a Hann window and interpolated FFT peaks; harmonic
  detuning must stay within half a semitone. Reported cents are diagnostic
  medians across matched partials/windows, not a tuning correction or a claim
  that every instrument is perfectly tuned. Vibrato and piano inharmonicity
  affect individual measurements.
- RMS envelopes use 10ms windows. Attack detection requires three consecutive
  windows above an adaptive threshold: max(0.0001, 4× local background RMS,
  0.003× attack-region peak RMS). These are approximate acoustic boundaries.
- `offset_seconds` includes 20ms before detected onset. `end_seconds` includes
  up to 50ms beyond the measured tail and is capped 300ms before the next slot.
  `duration_seconds = end_seconds - offset_seconds`; this is a bounded source
  window, not an unlimited sustain duration.
- MIDI 21 in both piano and chromatics-piano reaches the next-slot guard.
  These two windows require a short fade at the boundary during chunk
  generation. `tail_guarded` records this explicitly; no loop points are
  inferred. Other windows end before their next-slot guard.
- `timing.available_pitches` and the instrument pitch-map union/intersection
  describe coverage explicitly. GrandB layers retain separate measured windows.

## Reproduction and checks

Decoder: soundfile 0.14.0, libsndfile 1.2.2; NumPy 2.5.4.

From the asset-server directory:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/instrument-analysis-requirements.txt
.\.venv\Scripts\python.exe test/instrument_pitch_analysis_test.py
# Analyze and print a summary without modifying catalog/indexes:
.\.venv\Scripts\python.exe scripts/index_instruments.py
# Persist all reports and catalog after successful analysis:
.\.venv\Scripts\python.exe scripts/index_instruments.py --apply
npm run instruments:verify
npm run test:instruments
```

`--library-dir PATH` selects another library root. The analyzer checks every
original SHA-256 before analysis, retains the originals unchanged, and applies
results only after all recordings have been analyzed. Index files carry the
source checksum and method version; their own hashes are stored in the catalog.
Catalog publication uses an atomic replacement after index writes. If interrupted
during index publication, verification detects inconsistent hashes; rerun analysis.

The Node verifier checks hashes, decoder dimensions, source/method identity,
ordered and complete pitch coverage, non-overlapping windows, next-slot guards,
and catalog/index agreement. The seed importer can recover missing originals
without replacing enriched timing metadata or changing its checksums.

Validation passed: 9 Node regression tests, 6 signal-analysis tests, syntax and
format checks, and full verification of 25 original checksums / 25 index checksums /
1,999 note windows. Seed re-import reported zero copies and preserved the indexed
catalog byte-for-byte. No original MP3 was modified.

## Remaining migration work

All entries remain disabled. No program/bank assignment or browser decode
alignment is certified here. Generate bounded mono playback assets next, with
fades at guarded ends; check decoded clip boundaries before enabling sound
sources. Original audio files and the existing S3-backed player are unchanged.
