# FluidR3 importer — migration step 3

Current release: **FluidR3 GM is the default; all 128 FluidR3 and 21 Legacy instruments are enabled.** See [release/setup/rollback](RELEASE.md). Earlier stage descriptions below are historical.

The importer consumes the step-1 source lock at revision
044fab8e1456bfafc5776e86dfd6bb8697149aef. It parses note dictionaries as data,
never executes upstream JavaScript, and verifies both bundle and individual MP3
checksums against the audit. It does not fetch a moving branch or load audio
from an external host during normal playback.

## Asset preparation

- All 128 GM melodic instruments are materialized with namespaced IDs and their
  zero-based standard-bank program numbers. The current library/default remains
  legacy. FluidR3 instruments start enabled:false / assets_prepared.
- Exactly silent audited notes are excluded explicitly. The expected inventory is
  10,648 non-silent notes and 616 exclusions, including internal holes. No missing
  note is transposed or synthesized to pretend that coverage is complete.
- The current engine's mono contract is preserved: stereo is averaged and rounded
  to PCM16 without normalization. A downmix that clips or cancels a non-silent
  source is rejected. The pinned stereo MP3 bundles remain in the ignored source
  cache for recovery and possible future stereo support.
- A canonical mono WAV source per instrument stores its non-silent notes in pitch
  order. This is a reproducible intermediate, not a claim that the upstream source
  was a WAV recording. Source metadata and indexes retain the bundle revision and
  each original MP3's SHA-256. Canonical source files use registered audio/wav URLs.
- The discrete-note index records every raw source boundary, onset, retained window
  and silent exclusion. Leading silence is trimmed to retain up to 20ms pre-roll
  before a -80dB-relative-to-peak onset threshold measured after quantization.
  This is a boundary/index check, not a new spectral pitch certification.
- Playback uses the existing mono-octave-pcm16-v1 format: at most 12 pitches per
  chunk, 50ms silent gaps, 2ms fade-in, 20ms fade-out and the existing 48 MiB
  decoded-at-48kHz bound. Samples keep their finite endings and do not loop.
  Existing short-sample warnings remain relevant for notes beyond about 3 seconds.
- Different octave maps may legitimately contain identical audio (notably noise
  and effects). Unique asset IDs may share a content-addressed file. Every mapping
  still independently validates its source window, checksum, bounds and coverage.

## Publication and recovery

Run from fracto-asset-server with the existing Python analysis environment:

```powershell
# Read-only preview; offline requires the step-1 source cache:
.\.venv\Scripts\python.exe scripts/import_fluidr3.py --offline
# Create/reuse immutable files and verify before atomic catalog publication:
.\.venv\Scripts\python.exe scripts/import_fluidr3.py --offline --apply
npm run instruments:verify
npm run test:instruments
.\.venv\Scripts\python.exe -m unittest discover -s test -p '*_test.py'
.\.venv\Scripts\python.exe scripts/verify_instrument_assets.py --output instruments/playback-verification.json
npm run instruments:probe-http -- --output instruments/http-verification.json
```

Without --offline, missing bundles are downloaded only from the pinned commit and
must match the lock before use. --library-dir and --audit-dir choose explicit roots.
--workers 1 through 4 bounds preparation concurrency (default 4). Preview builds
in memory and checks conflicts but does not publish files or the runtime catalog.

New outputs use exclusive creation; an existing differing file is an error.
Matching files are reused. A failed or interrupted import can leave unreferenced
assets; it does not publish a partial catalog. A partially written conflicting
file must be recovered explicitly, never silently overwritten. No automatic
pruning or deletion of old assets is performed.

The importer writes a private candidate catalog, runs the Node verifier against
it using --catalog-file, confirms that the active catalog has not changed, then
atomically replaces it. Verification failure or concurrent change preserves the
active catalog. A byte-identical rerun does not rewrite it. Existing FluidR3
assignments/status flags are preserved only if the prepared source and metadata
are identical; differing imports require an explicitly versioned source.

Old 10/20-second grid analysis/preparation commands refuse mixed catalogs rather
than applying their grid assumptions to discrete-note sources. Use this importer
for FluidR3 recovery. Checksummed JSON is kept LF-stable through .gitattributes;
upstream notices retain their exact original bytes.

Audio storage remains ignored by Git. Catalog metadata, indexes, import evidence
and source notices are tracked; they cannot reproduce audio without the pinned
bundles or network access to that revision. See import-report.json for counts,
logical playback bytes and quantization error. Identical WAV aliases can make
physical disk usage smaller than summed logical asset sizes.

## Boundaries and next step

The library container becomes active when prepared assets are published, meaning
it is present in storage, while individual FluidR3 providers remain disabled.
No default-library change or automatic switch from the current instruments occurs.
Native browser decoding/listening, representative instrument comparison, and
library enablement belong to step 4. The importer does not certify quality,
add percussion kits, introduce velocity timbre layers, or add sustained loops.

The original sample license declaration and packaging notice are retained in
upstream/README.md and upstream/LICENSE.txt. The asset metadata keeps source
URLs, revision and conversion details. Follow the source audit's attribution
requirements before publishing credits for the prepared library.


## Recorded validation (2026-11-02)

The published catalog has 149 entries: 21 enabled legacy instruments and 128
prepared, disabled FluidR3 instruments. Library version is 4; default remains
legacy. Existing legacy instrument objects are unchanged except the step-2
library identity fields.

- 10,648 FluidR3 note windows; 616 explicitly excluded silent source keys.
- 1,099 logical octave chunks, sharing 1,098 physical checksum-addressed WAVs.
- Canonical source WAVs: 2,938,512,896 bytes. Logical playback bytes:
  2,980,666,710; physical playback bytes: 2,977,306,540.
- Largest new chunk: 7,314,560 decoded bytes at 48 kHz (below 48 MiB).
- Source downmix quantization error: at most 0.0000152587890625.
- Catalog: 7,032,191 bytes, below the 32 MiB server/client bound.
- Node verification passes all 153 sources, 1,282 logical chunks and 12,647 total
  legacy/FluidR3 mappings. Independent playback-to-source interior comparisons
  pass for every one of the 12,647 windows with the same maximum PCM error.
  New FluidR3 comparisons use the canonical mono source; pinned MP3-to-canonical
  quantization is separately measured by the importer.
- HTTP probe passes all 1,435 source/playback URLs, HEAD and 32-byte ranges,
  credentialed CORS and conditional catalog revalidation.
- Engine probe validates all 12,647 maps in explicit prepared-source mode and
  loads the actual FluidR3 flute chunk once for four voices, with replay/cleanup.
  Its decoder and clock are stubs; this does not claim native browser output.
  Normal discovery still validates only the 1,999 enabled legacy maps.
- 29 asset-server tests, 23 Python tests and all 109 MIDI tests pass. Probe lint
  passes. No product UI or audio scheduling change was required for this import.

A full offline repeat import reused all prepared files (new_files:0) and left
the active catalog byte-for-byte identical. No FluidR3 source was enabled.


Step 4: all 128 FluidR3 providers are now playback_verified after complete native
48kHz rendering. They remain disabled pending library-aware selection in step 5.
See [verification results](VERIFICATION.md).
