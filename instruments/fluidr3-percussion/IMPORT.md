# FluidR3 percussion importer — step 3

**Current release: Standard is verified and enabled. See [release/install guide](RELEASE.md).**

The preparation-stage behavior below is retained for reproducibility.
The other 30 kits remain source-audited. No percussion provider or assignment UI
is enabled by this step. The melodic default and all 149 melodic entries remain
unchanged.

## Renderer and source pins

The source is the step-1 original FluidR3 GM SF2, SHA-256
`74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0`.
Its source/inventory checksums are checked before rendering.

Offline rendering uses the official **FluidSynth 2.6.2** Windows x64 C++11 build,
released 2026-11-01; source commit `c3b244ddfd094489a5490beee013c621a504adf2`.
Archive SHA-256:
`808295345d43c9c428f3fa87d29fbf97a9926f356df95559ff2689f3bd4072d7`.
`renderer-lock.json` pins the complete 28-file archive inventory, official asset
URL/digest, release identity, source commit and supplied LGPL license notice.
The full license is retained in `upstream/FLUIDSYNTH-LICENSE`.

The wrapper checks the archive, complete extracted-file list, every extracted
file against both its lock and original ZIP bytes, and the DLL's reported version
before use. It uses the C API through Python ctypes; it does not create an audio
or MIDI driver, invoke a shell renderer, or execute upstream JavaScript. Renderer
binaries stay in ignored `source-cache/renderer/`. The renderer is an offline
maintenance tool; Node and browser playback do not need Python, FluidSynth or SF2.
The current executable pin requires **64-bit Windows**. Another platform needs its
own audited renderer build/pin; output is not promised bit-identical across builds
or architectures. Do not substitute a different DLL under the existing pin.

The original SF2's MIT notices remain with this sample collection. FluidSynth's
LGPL notice describes the renderer, not a replacement license for the samples.
No renderer DLL is included in the tracked runtime or delivered audio endpoints.

## Synthesis and finite-hit policy

`fluidr3_drum_renderer.py` records the complete preparation recipe in CONFIG and
binds it to each manifest using a SHA-256 over the exact UTF-8 `config_json`.

- Internal SF2 bank 128, requested kit program, MIDI channel index 9 (channel 10).
- Stereo float rendering at 48,000 Hz; fixed FluidSynth gain 0.2; seventh-order
  interpolation; one synthesis CPU core; chorus and reverb disabled. The pinned
  synth's default MIDI controller state is retained; each hit starts with all
  earlier channel voices off, so offline hits never choke each other's tails.
- Note-off at exactly 100 ms, including looped source zones. The renderer waits
  for at least 200 ms of stereo signal below 1/65536 peak after a minimum 300 ms
  render. A hit that has not decayed by **30 seconds fails**, rather than being
  silently cut. This is a documented one-shot preparation policy, not an attempt
  to reproduce every possible live SF2 gate duration or pedal behavior.
- The waveform is stereo-averaged to mono without per-hit normalization. Leading
  silence is trimmed with up to 2 ms retained pre-roll; 20 ms after the last
  above-threshold mono frame is retained. A 0.5 ms attack fade and 5 ms tail fade
  produce clean finite edges, then samples are rounded to PCM16. Nonfinite,
  clipped, silent, phase-cancelled or quantized-silent hits fail preparation.
- Source presets perform tuning, envelopes, filters, panning and modulation during
  synthesis. Raw SF2 sample links are not used to guess stereo pairs or rewritten.
  This handles the source metadata anomalies recorded by the audit.

This recipe has not yet been auditioned against every named drum sound. In
particular the 100 ms gate and trim/fade policy need step-4 listening/timing checks;
`assets_prepared` is not a claim of audible identity, naturalness or browser readiness.

## Velocity and choke semantics

Each source note's declared velocity coverage is partitioned at the four tier
boundaries 1–31, 32–63, 64–95 and 96–127 **and every actual SF2 zone boundary**.
Coverage holes remain holes. Each resulting interval is rendered at its upper
velocity, recorded as `render_velocity`. Standard produces 268 intervals over
61 note identities (27–87), not just four arbitrary recordings per note.

SF2 velocity generators are applied by the renderer. Continuous variation within
an interval is still approximated by the representative render. Later playback
must use the recorded representative when applying gain; applying the ordinary
melodic velocity multiplier again would double-attenuate the baked dynamics.
The exact gain approximation and mixing levels need step-4/5 verification.

The kit's source `choke_groups` remain intact. Offline preparation deliberately
renders isolated hits to their tails; it does not bake another hit into a sample.
Runtime choke behavior remains a later engine task, scoped to kit/route and aware
that sibling voices of one hit must not choke each other.

## Asset format, manifests and validation

`sf2-drum-hits-pcm16-v1` is distinct from melodic octave samples. Each canonical
mono PCM16 WAV contains at most 12 ordered hit windows with 50 ms zero gaps and
at most 48 MiB decoded float data at 48 kHz. A hit identifies MIDI note, inclusive
velocity bounds, render velocity, exact frame/second bounds and a PCM SHA-256.
The importer packs ordered note/velocity identities; no drum is pitch-shifted.

Files are immutable and content-addressed:

- Ignored audio: `playback/<kit-id>/<audio-sha256>.wav`.
- Tracked proof: `indexes/<kit-id>-<config-hash-prefix>-render.json`.
- Catalog: per-kit `rendering` identity and `playback_assets`; root
  `percussion_preparation` totals are separate from melodic preparation totals.

A manifest binds source SF2/inventory, renderer lock/version, exact config, all
asset mappings and per-hit stereo/quantization/trim evidence. The server verifies
manifest hashes and identities; full integrity checks additionally verify WAV
headers, whole-file and per-hit PCM checksums, complete note/velocity coverage,
zero gaps, finite faded edges, bounds and preparation totals. File reads are
bounded and symlinks are rejected. Neither source cache nor renderer cache is
needed to validate/deploy already prepared files.

`GET /instruments` publishes sanitized prepared chunk URLs and hit mappings.
Standard remains `enabled:false`, `available:false`; `assets_available:true`
means only that its prepared files exist. Private manifest/storage paths and
internal render metrics are omitted. Each registered chunk uses the same
credentialed, versioned WAV route, range/HEAD behavior and integrity checks as
existing assets. The original SF2 is not exposed as an audio asset. UI catalog
validation accepts prepared metadata but never creates a melodic or percussion
provider from this collection, even through prepared-source verification opt-in.

## Commands and recovery

Run from fracto-asset-server with the existing numpy/soundfile analysis environment:

```powershell
# Recover/check pinned SF2 and audit metadata if necessary:
.\.venv\Scripts\python.exe scripts/audit_fluidr3_percussion.py
# Recover/check the exact official Windows renderer ZIP/files:
.\.venv\Scripts\python.exe scripts/fetch_fluidr3_drum_renderer.py
# --offline refuses network and requires the ZIP already in source-cache/renderer.
# Read-only preview: synthesizes/checks in memory without publishing assets/catalog:
.\.venv\Scripts\python.exe scripts/import_fluidr3_percussion.py
# Prepare/reuse immutable files; validate a private candidate and atomically publish:
.\.venv\Scripts\python.exe scripts/import_fluidr3_percussion.py --apply
npm run instruments:verify
npm run test:instruments
.\.venv\Scripts\python.exe -m unittest discover -s test -p '*_test.py'
npm run instruments:probe-http -- --output instruments/fluidr3-percussion/prepared-http-verification.json
```

Default kit is `standard`; `--kit KEY` can be repeated, or `--kit all` selects the
31 audited presets. Other kits have not been prepared/verified in this step.
`--library-dir PATH` selects an isolated complete library. Rendering itself never
uses the network. Source/renderer cache recovery is a separate explicit command.

Any missing/changed pin, invalid render, conflicting immutable file, out-of-budget
hit or failed candidate verification prevents catalog publication. Existing
imported/verified/enabled kit state cannot be silently reset by rerunning this
importer or the step-2 metadata command. An interrupted run may leave unreferenced
immutable files; no audio is automatically pruned. Matching files are reused;
partial/conflicting files require explicit recovery. A complete second Standard
run reused every file (`new_files:0`) and left catalog bytes unchanged.

Deploy the prepared WAVs, tracked render manifest and matching catalog together.
Keep source/renderer caches for rebuilds, but not as served public data. The next
step is Standard sound-map, velocity, tails and native browser verification;
only later steps connect/enable percussion playback and assignments.

## Recorded result

Standard: **268 hit windows, 23 chunks, 26,528,042 encoded bytes**; largest decoded
chunk **9,860,316 bytes at 48 kHz**. All 31 kits remain disabled. Existing melodic
entries, sources, chunks and default are unchanged. Tests: 126 MIDI, 35 server,
36 Python; production UI build and targeted lint pass (existing build chunk-size
advisory). Full catalog/source/index/playback verification and a second identical
import pass. HTTP probe covers all **1,458** original/melodic/drum audio URLs.
See `import-report.json`, `prepared-http-verification.json` and
`import-validation.json`. No native drum playback or listening certification is
claimed by this preparation step.

Step 4 completed: see [Standard verification](VERIFICATION.md). Verified identical imports retain their evidence/status; no percussion provider is enabled.
