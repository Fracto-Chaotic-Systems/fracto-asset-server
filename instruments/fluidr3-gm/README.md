# FluidR3_GM source audit — migration step 1

Current release: **FluidR3 GM is the default; all 128 FluidR3 and 21 Legacy instruments are enabled.** See [release/setup/rollback](RELEASE.md). Earlier stage descriptions below are historical.

Step 3 adds the [FluidR3 importer](IMPORT.md). The audit findings below describe
the original MP3s; prepared playback excludes silent notes and stays disabled.

Audited 2026-11-02. This directory is a source audit, separate from the active
instrument library. No runtime endpoint, provider, assignment or audio file in
the active catalog was changed.

## Source pin and licensing evidence

- Repository: https://github.com/gleitz/midi-js-soundfonts
- Revision: `044fab8e1456bfafc5776e86dfd6bb8697149aef`
- Revision date: 2021-12-17T20:51:59Z; branch observed: gh-pages.
- Root Git tree: `4ac0b4d7db835ea68d715d0621186e86d94852cb`.
- Selected collection: FluidR3_GM; selected audit encoding: MP3.
- Upstream README explicitly declares the FluidR3 samples under
  [CC BY 3.0 United States](https://creativecommons.org/licenses/by/3.0/us/).
  Its root LICENSE.txt instead carries the MIT notice for the packaging software,
  Copyright (C) 2012 Benjamin Gleitzman. Do not substitute that software license
  for the sample license. Other collections have different licenses.
- Exact pinned upstream README and MIT notice are retained under upstream/;
  source-lock.json records their hashes and the sample-license declaration.
  Future served credits must identify the source collection, source URL/revision,
  applicable license and conversions performed, retaining supplied notices.
  The selected bundle contains no separate audio-author credit file; reconcile
  underlying SF2 creator credits before publishing sample attribution.
- We pin the pre-rendered distribution, not an original SF2 whose precise bytes
  or rendering settings have been established. Do not infer original velocity,
  loop points, modulation or release envelopes from these audio files.

## Measured findings

| Property | Result |
| --- | --- |
| Named melodic GM programs | 128; zero-based 0–127, UI display 1–128 |
| Embedded MP3 notes audited and fully decoded | 11,264 |
| Keys in each program | 88, MIDI 21–108 (A0–C8) |
| Exactly silent files | 616 across 35 programs |
| Non-silent files | 10,648; signal presence is not a pitch/quality certification |
| Decoded format | Every note: 44,100 Hz, stereo, 137,984 frames |
| Duration | Every note: 3.128888888888889 seconds |
| Dynamics supplied by packaging | One sample per pitch; no selectable velocity layers |
| MP3 bundles cached | 318,463,450 bytes, including base64 wrappers |
| Extracted encoded MP3 bytes audited | 238,543,818 bytes; not published/imported |
| Decoded nonfinite values / samples beyond ±1 | None |
| Last 20ms RMS above 0.001 | 7,383 notes; inspect/fade endings before playback preparation |
| Native browser verification | Not performed in this step |

All note bytes match the pinned Git blob ID and length of their corresponding
individual MP3 file. Every bundle and embedded note also has a recorded SHA-256.
OGG, gzip and direct-file alternatives are inventoried using Git IDs/sizes;
OGG audio and gzip payloads were not downloaded/decoded by this MP3 audit.
The declared render length is not known; the measured decoded duration includes
whatever padding the pinned MP3s contain. File size and waveform existence do
not establish tonal accuracy, natural range or sample quality.

These findings change the migration assumptions:

- Key presence cannot be treated as usable coverage. For example, contrabass
  has signal only at 21–57; violin also has an internal silent hole at pitch 94.
  [COVERAGE.md](COVERAGE.md) lists every program's non-silent ranges and holes.
- Existing piano velocity layers cannot be reproduced by simply importing this
  package. Velocity gain remains possible but does not create distinct timbres.
- Samples end after about 3.13 seconds, materially earlier than many current
  recordings. Our engine cannot invent looping. Preserve bounded-note warnings;
  consider original SF2 rendering if sustained-note quality is inadequate.
- Samples are stereo, while the current bounded-WAV contract is mono PCM16.
  A later step must explicitly choose downmixing or extend stereo support.
- This is the 128-program melodic set. It does not establish a channel-10 drum
  kit or GS/XG bank coverage. GM synth_drum/taiko programs are not drum kits.
- The runtime 128-instrument limit and existing 8 MiB HTTP catalog cap need
  attention when adding this library. This detailed audit lock is over 8 MiB
  and must never be used verbatim as the runtime catalog.

## Files and reproduction

- source-lock.json: complete pinned inventory plus all note hashes and decoded
  measurements. This is audit data, not the engine's runtime catalog schema.
- audit-summary.json: counts, dimensions, environment and lock checksum.
- replacement-candidates.json / REPLACEMENTS.md: 14 candidate single-source
  replacements, seven retained custom composites and explicit coverage gaps.
  These mappings are proposals and do not change MIDI program assignment.
- source-cache/: ignored download cache, checked against pinned Git blobs.
  No JavaScript from the upstream project is executed. The parser accepts only
  the known wrapper and a JSON-like note dictionary with a final trailing comma.
  Existing corrupt cached files cause an error instead of being overwritten.

Run from fracto-asset-server using Python and the already specified analysis
requirements. The output directory is independent of FRACTO_INSTRUMENT_DIR:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/instrument-analysis-requirements.txt
.\.venv\Scripts\python.exe scripts/audit_fluidr3.py
# Recheck all bytes and measurements without network, using the cached sources:
.\.venv\Scripts\python.exe scripts/audit_fluidr3.py --offline
.\.venv\Scripts\python.exe -m unittest discover -s test -p '*_test.py'
```

Use --output-dir ABSOLUTE_PATH for a separate audit/cache location. Initial
retrieval downloads approximately 318 MB of MP3 bundles plus a Git inventory and
small source documents. An offline rerun requires the ignored cache; Git alone
retains the evidence, hashes and notices, not those source bundles.

Step 1 is complete. Next: add explicit library identities and a compatible
catalog schema before importing or enabling any FluidR3 provider. Keep current
sounds available until replacement listening and coverage tests pass.


Step 4: all 128 FluidR3 providers are now playback_verified after complete native
48kHz rendering. They remain disabled pending library-aware selection in step 5.
See [verification results](VERIFICATION.md).
