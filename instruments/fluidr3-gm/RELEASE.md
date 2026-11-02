# FluidR3 GM release — 2026-11-02

Release tag: `release/fluidr3-gm-v1` in both fracto-asset-server and fracto-ui.
This is a local Git release; no remote push or production deployment is implied.

## Delivered behavior

All Music defaults to FluidR3 GM. Original MIDI assignments resolve each note's
standard-bank GM program in the selected library, including program changes.
The selector offers Legacy recordings and FluidR3 GM; compatible manual overrides
and mixer settings survive switches. Switching stops pending/active playback and
requires Play. File replacement resets overrides/mix but retains library selection
within the mounted page. First Play waits for initial catalog discovery; failed
discovery leaves GrandB fallback available. Refresh retains explicit selection.

128 verified FluidR3 instruments plus 21 Legacy sounds are enabled. The catalog
has 153 originals, 1,282 logical playback chunks and 12,647 note windows. FluidR3
contains 10,648 usable notes and 616 excluded silent keys. All library audio is
served by the asset server through existing authenticated/versioned routes;
upstream scripts are parsed offline as data and never executed in the browser.

## Source, notices and limitations

Pinned distribution: gleitz/midi-js-soundfonts, commit
`044fab8e1456bfafc5776e86dfd6bb8697149aef`, FluidR3_GM MP3 collection.
See [sample attribution](NOTICE.md), [source lock](source-lock.json),
[coverage](COVERAGE.md), and retained `upstream/` notices. The distribution declares
CC BY 3.0 US for these samples; its MIT license covers packaging software.
This release pins pre-rendered MP3s, not an independently authenticated SF2 build.

Keys are limited to MIDI 21–108 with instrument-specific holes. No percussion kits,
nonzero banks, looping, transposed missing notes, or additional velocity layers.
MP3s are stereo 44.1 kHz and approximately 3.13 seconds. Playback assets average
stereo to mono PCM16, trim onset with 20 ms pre-roll, and use bounded note windows,
2 ms/20 ms fades, and 50 ms separation. Gain differences from Legacy are retained.
Long notes can end before MIDI note-off; the UI reports short-sample warnings.
Verification establishes signal, bounds and lifecycle, not human quality ranking.
Native audio evidence covers Chromium at 48 kHz, not every browser/output device.
Legacy provenance still has unknown original creator/usage terms; no new license
is asserted for those recordings. No public distribution clearance is claimed.

## Install and deploy

Install Node dependencies using each repository's lockfile (`npm ci`). Python is
used only for offline asset maintenance, never the Node service or MIDI playback.
For importer work, create `.venv` and install `numpy==2.5.4 soundfile==0.14.0`;
validation used libsndfile 1.2.2 with MP3 support.

Audio is deliberately excluded from Git. Before starting the service, restore
`instruments/originals/` and `instruments/playback/` from the verified asset store
alongside the matching catalog and tracked indexes. Catalog source storage is
3,345,823,617 bytes; logical playback storage is 4,351,268,364 bytes (shared
content-addressed files reduce physical storage). Provision additional space for
source cache and conversion intermediates. A Git checkout alone cannot play audio.

To regenerate FluidR3 on a library with the Legacy assets restored:

```powershell
# From fracto-asset-server; downloads only pinned, checksum-checked bundles:
.\.venv\Scripts\python.exe scripts/import_fluidr3.py --apply
# Use --offline when the ignored pinned source-cache is already restored.
npm run instruments:verify
npm run test:instruments
.\.venv\Scripts\python.exe -m unittest discover -s test -p '*_test.py'
.\.venv\Scripts\python.exe scripts/verify_instrument_assets.py --output instruments/playback-verification.json
npm run instruments:probe-http -- --output instruments/http-verification.json
# From fracto-ui:
npm run test:midi
npm run build
```

The importer preserves enabled/status flags only for byte-identical regenerated
instrument entries and retains the chosen catalog default. It verifies a private
candidate then atomically publishes it; it never prunes assets. Never run the
Legacy grid indexer/preparer against the mixed catalog. For Legacy reconstruction,
use an isolated Legacy-only library and its documented historical workflow, then
verify the final matching asset store; do not replace the mixed runtime catalog.

Deploy asset files before publishing the matching catalog, then deploy the UI.
Keep existing asset URLs/files available for clients using older catalogs. Verify
service authorization, the configured asset origin and HTTPS/localhost (required
for browser integrity checks). Refresh libraries or reload All Music. The service
catalog loader checks file metadata and reloads changed catalogs; a coordinated
service restart is also available during deployment. Retain both tagged repositories and asset store
as the coordinated release. No upstream runtime network access is required.

## Validation and rollback

117 MIDI tests, 29 asset-server tests, 23 Python tests; production UI build and
targeted lint pass. Build retains the existing large-chunk advisory. Integrity
checks cover every original, index and playback asset. The final HTTP probe checks
1,435 HEAD URLs and range bytes, catalog conditional 304, and authorization.
Full PCM source comparison checks all 12,647 windows. Native all-note verification
covers all 128 FluidR3 providers, 1,099 logical FluidR3 chunks and 10,648 usable
notes, rejecting every silent key. Seven representative real-time cases and the
full default-library page regression cover Stop, replay, source switching, mixing,
file replacement, timing and cleanup (zero open contexts/nodes/timers/callbacks).
See `release-validation.json`, [verification](VERIFICATION.md), and UI
`test/midi_reports/fluidr3-default-library.json`. Earlier snapshots intentionally
retain the catalog hashes/defaults that existed when they were measured.

For immediate per-user rollback select Legacy recordings. For default rollback,
prepare a copy of catalog.json with `default_library_id: "legacy"`, validate using
`node scripts/instruments.js verify --catalog-file ABSOLUTE_CANDIDATE_PATH`, then
atomically publish it and restart the service. Existing explicit user choices
remain until changed or the page is remounted. Keep FluidR3 assets registered for
existing clients; do not delete sound data. A full code rollback uses both prior
repository commits recorded in release-validation.json plus their matching catalog
and asset store. Do not roll back one repository independently of its assets.
