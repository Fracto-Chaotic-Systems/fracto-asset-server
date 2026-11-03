# Instrument library seed

Current release: **FluidR3 GM is the default; all 128 FluidR3 and 21 Legacy instruments are enabled.** See [release/setup/rollback](fluidr3-gm/RELEASE.md). Earlier stage descriptions below are historical.

Current playback status (2026-11-02): **all 21 instruments are enabled** after
75 native Chromium decode/render probes (low/middle/high pitches of every
recording layer) passed through the sample cache and voice engine at 48 kHz.
The catalog marks them playback_verified; detailed evidence is recorded in
browser-verification.json in the asset-server instruments directory. Earlier
disabled/pending statements below describe the initial migration stages.
Native probes confirm signal output, not a subjective listening review.
Reload All Music to fetch the updated catalog. A source can still be disabled
for a track containing notes outside that instrument's verified pitch range.


The asset server owns the recovered source recordings and their catalog.
`catalog.json` has 21 instrument entries / 25 original MP3 recordings from
`media-frameworks/react-apps` commit
`07898f8fb1a3809c115c79d500fd792cddbcd95c` (2020-11-13).

## Contents and status

- GrandB piano groups five labeled velocity layers: p, mp, mf, f, ff.
- Other single-source entries: acoustic bass, blown bottle, cello, chromatics
  piano, distortion guitar, flute, harmonica, harpsichord, piano, pipe organ,
  vibraphone, violin 10 loud, and violin 15 loud.
- Seven explicitly named composite entries retain the original filename names
  and numbers. Those numbers are not treated as verified mix coefficients.
- The violin 10/15 names are preserved as separate entries; their meanings are
  not assumed to be velocity levels.

Every original has a SHA-256 checksum, byte length, relative path, MIME type,
source Git path and blob ID. The catalog records the exact source commit,
commit timestamp and repository. IDs remain stable; checksums identify content.
The source creator and usage terms remain unknown; no new license is asserted.

The library is now **integrity- and indexing-verified**, with 1,999 bounded
pitch windows across 25 recordings. `catalog.json` is now library version 3,
with 183 bounded mono playback chunks covering those same windows.
Each recording's `timing` references a checksum-protected report under `indexes/`;
reports contain per-pitch nominal time, measured onset/tail, playback offset/end,
evidence and explicit excluded pitches. Instrument pitch maps reference those
reports and expose available/common pitch coverage across layers.

Every instrument remains disabled. Program/bank assignments
remain empty; browser playback verification is pending. GrandB uses 20-second
slots, other recordings use 10-second slots, and usable pitch ranges vary. See
[INDEX_VERIFICATION.md](INDEX_VERIFICATION.md) for ranges, methods, tests and
reproduction commands. GrandB S3 remains the default fallback; the player now discovers this catalog.
[The HTTP API](HTTP_API.md) now exposes catalog metadata and registered audio
URLs. Local disk paths and raw provenance/index files are not exposed.

## Recover the originals

Run from `fracto-asset-server`, with Git and the source repository available:

```powershell
npm run instruments:seed -- --source-repo D:\mediaplex\react-apps
npm run instruments:verify
npm run test:instruments
```

The importer reads the pinned historical Git blobs, not working-tree files.
It neither checks out files nor changes the source repository. MP3 bytes are
read directly through Node buffers, without PowerShell text redirection or
re-encoding. A narrowly scoped Git safe-directory option is used only for the
explicit source path; global Git settings are not changed.

Default destinations are relative to this service, independent of the current
working directory:

- `instruments/catalog.json`: tracked metadata/provenance.
- `instruments/originals/*.mp3`: ignored local asset storage.

Use `--library-dir ABSOLUTE_PATH` with either command for an alternate library
root. HTTP URLs are implemented; persistent deployment storage must be provisioned separately. These originals are not included in Git,
so a checkout alone does not populate audio. Use the importer with access to
the source Git objects, or transfer the originals with checksum verification.
The importer itself is an offline maintenance command, not a server-start task.
Runtime playback will not depend on the react-apps repository.

Imports are idempotent: matching originals are reused. The importer preflights
all source metadata and existing destinations, refuses differing files or
seed identity metadata, and writes the catalog only after originals are recovered.
An interrupted import can be rerun; a partially written conflicting original
is reported, never silently overwritten. Verification rereads every registered
file and checks byte length and SHA-256; a missing/corrupt file fails the command.
It also verifies referenced index hashes and safe pitch-window/catalog consistency.
It now also verifies generated playback WAVs and mappings by default.
`verify --sources-only` explicitly skips generated assets for recovery work.
It does not certify browser playback readiness.

The manifest retains schema version 1; library version 2 added verified indexes
and version 3 adds playback asset metadata. The server catalog endpoint is implemented; engine and assignment integration are implemented. Do not enable these entries
by changing a flag before playback assets and browser output have been verified.

The seed command preserves index-analysis metadata when seed identities match.
It can rehydrate missing originals after indexing; it never resets verified maps.

See [PLAYBACK_ASSETS.md](PLAYBACK_ASSETS.md) for chunk generation, memory limits,
recovery and output/source comparison. Generated WAVs live in the ignored
`playback/` directory. The player uses verified registry providers and bounded pitch windows. HTTP routes serve the prepared assets
through registered, versioned URLs; see [HTTP_API.md](HTTP_API.md).


See [MIGRATION_VERIFICATION.md](MIGRATION_VERIFICATION.md) for final test evidence,
setup, enablement boundaries and recovery instructions.


The [FluidR3 GM source audit](fluidr3-gm/README.md) pins the active default library.
The current catalog enables all 128 verified FluidR3 instruments and 21 Legacy
sounds (149 total). `default_library_id` is `fluidr3-gm`; Legacy remains selectable.
Short finite samples and excluded silent keys are explicitly modeled.

See [multi-library support](MULTI_LIBRARY.md), [import/recovery](fluidr3-gm/IMPORT.md),
and [native verification](fluidr3-gm/VERIFICATION.md). The default change is recorded
in `fluidr3-gm/default-activation.json`. Earlier reports retain their historical
catalog defaults and enabled flags.


[Percussion source audit](fluidr3-percussion/README.md): original SF2 pinned with 31 drum-kit inventories and MIT notices. Standard is the first planned kit; no percussion has been imported or enabled.


Step 3: [prepared percussion assets](fluidr3-percussion/IMPORT.md) add Standard kit render manifests, bounded note/velocity hit chunks and sanitized authenticated WAV URLs. Assets may be available while kit playback remains disabled. This supersedes the step-2 empty-assets-only gate; no percussion provider is enabled yet.

Current percussion release: [FluidR3 Standard v1](fluidr3-percussion/RELEASE.md), coordinated local tag release/fluidr3-percussion-v1. Includes verified Standard playback and kit assignments; other kits remain disabled.
