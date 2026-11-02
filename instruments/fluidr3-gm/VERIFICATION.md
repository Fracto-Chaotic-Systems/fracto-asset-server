# FluidR3 verification — migration step 4

## Current default: FluidR3 GM (migration step 6)

The catalog now declares `default_library_id: "fluidr3-gm"`. All Music selects it
when catalog discovery completes, and new files use **Original MIDI assignment**.
Each note resolves its recorded GM program within FluidR3, including program
changes. The selection persists across file replacement within the mounted page;
manual route overrides reset on replacement. Explicit Legacy selection and
compatible manual overrides survive catalog refresh. Before discovery or when the
catalog cannot be loaded, the existing GrandB fallback remains available.

Legacy recordings is still selectable and all 149 instruments remain enabled.
Missing/silent keys, percussion and nonstandard banks report unavailable rather
than silently substituting piano. Samples remain finite, without invented loops
or additional velocity layers. This changes the default choice, not the audio
assets, gain, or memory limits. To roll back, set the catalog default to `legacy`
and validate it using `npm run instruments:verify`; clients receive it on refresh
unless they explicitly selected a library. Earlier step 4/5 reports record the
historical Legacy default.

Validation: 117 MIDI tests cover initial defaults, replacement, late discovery,
manual overrides and Legacy selection. Full catalog verification confirms all 149
enabled instruments. Production build and targeted lint pass.


Verified 2026-11-02 in the in-app Chromium browser at a native 48,000 Hz render
rate. All 128 FluidR3 providers are now marked playback_verified. They remain
enabled:false until step 5 connects library-aware selection; the current enabled
legacy library and legacy default are preserved.

## Results and scope

| Check | Result |
| --- | --- |
| Complete library | 128 instruments, all 10,648 usable pitches rendered |
| Native chunk decode/resample | All 1,099 logical chunks; 44.1kHz mono WAV to 48kHz |
| Missing/silent source keys | All 616 excluded keys rejected by assignment |
| Per-note signal | Finite, nonzero output; no clipping at tested velocity 100 |
| Per-note release | Below 1e-7 peak in the post-release window |
| Original MIDI programs | Every usable pitch resolves within FluidR3's explicit bank-0 program scope |
| Largest decoded chunk | 7,314,560 bytes; one fetch/decode per tested chunk |
| Representative real-time controllers | Piano, flute, violin, bass, guitar, organ, vibraphone: all pass |
| Representative polyphony | Four overlapping voices share one decoded chunk |
| Transport | Replay, natural completion, Stop silence, bounded held notes pass |
| Held-note boundaries | Exact silence after the source window; no next-pitch bleed |
| Resource accounting | Zero frames, timers, open contexts, product connections or callbacks after each real-time disposal |
| Representative pitch hypotheses | All 14 legacy/FluidR3 C4 clips match in at least two of four spectral windows |
| Unit/integration suites | 111 MIDI, 29 server and 23 Python tests pass; targeted lint and production build pass |
| Page regression | Rendering, zoom/fit, labels, 64 tracks, dense 10,000 notes, mixer, assignments and cleanup pass |

The full-bank test uses native OfflineAudioContext rendering, one octave at a
time, with the actual sample cache, checksum validation and voice code. It renders
every usable note at velocity 100, checks a post-release silence interval, checks
memory dimensions, and checkpoints after each instrument. It does not keep the
whole library resident. Seven separate real AudioContext tests capture the graph
also connected to AudioDestination and verify timing/Stop/replay/cleanup. This
proves graph output, not physical speaker volume or human sound preferences.

The spectral analysis tests the C4 hypothesis using either a fundamental or a
coherent harmonic series. It is limited to the seven representative sounds in
each library; noise/effects and every pitch were not subjected to a tonal-quality
classification. Other browsers, native rates and human quality rankings remain
outside this certification. No new velocity timbre layers, drums or sustain loops
were introduced.

Evidence: browser-verification.json summarizes the scope and hashes the detailed
browser-all-notes.json, browser-representatives.json and representative-analysis.json.
Reports identify the exact input catalog revision and chunk checksums. The catalog
revision changed only to publish verification status; the audio is unchanged.

## A/B findings

The browser rendered C4 at velocity 100 with a five-second MIDI hold using the
same voice code and source gain policy. Each 5.4-second clip contains the note
and its trailing silence. Initial RMS is measured from 0.1 to 0.8 seconds.

| Sound | Legacy source window | FluidR3 window | FluidR3 initial level relative to legacy |
| --- | --- | --- | --- |
| Piano | 14.19s | 3.13s | -13.36 dB |
| Flute | 7.87s | 3.13s | -7.40 dB |
| Violin | 1.18s | 3.13s | -10.31 dB |
| Acoustic bass | 7.82s | 3.13s | -9.01 dB |
| Distortion guitar | 7.58s | 3.13s | -3.70 dB |
| Organ | 8.61s | 3.13s | -15.15 dB |
| Vibraphone | 7.61s | 3.13s | -22.68 dB |

The piano comparison uses the legacy asset-grandb provider, not the separate S3
fallback. These are single-pitch observations, not whole-bank loudness presets.
FluidR3 output is silent at 4–4.8 seconds in all seven holds; six legacy sources
still have measurable output then. The legacy violin ends sooner than FluidR3.
The existing bounded-note warning therefore remains necessary. FluidR3's one
sample per pitch also lacks the legacy GrandB collection's distinct velocity
layers. These measured differences do not establish a universal quality upgrade.

The raw audition is fluidr3-ab-audition.wav. A separate
fluidr3-ab-level-matched.wav matches each FluidR3 clip's initial RMS to its legacy
partner without changing source assets. It is derived from the raw 16-bit export
and saved as PCM24; it cannot recover precision discarded by that export. No
runtime gain or normalization policy was changed. Level matching remains an
analysis aid, not a preset to apply without whole-range headroom tests.

Audition order (legacy first, FluidR3 second for each pair):

| Pair | Legacy starts | FluidR3 starts |
| --- | --- | --- |
| Piano | 0.0s | 5.4s |
| Flute | 10.8s | 16.2s |
| Violin | 21.6s | 27.0s |
| Bass | 32.4s | 37.8s |
| Guitar | 43.2s | 48.6s |
| Organ | 54.0s | 59.4s |
| Vibraphone | 64.8s | 70.2s |

Keep the legacy default for now. FluidR3 is mechanically ready for optional
library-aware selection in step 5. Review the A/B clips before making it exclusive
or switching the default; duration, levels, missing keys and piano dynamics are
material differences. Retain the legacy layered piano and custom composites.

## Reproduce

From fracto-ui:

```powershell
node test/midi_browser/serve.mjs D:/temporary/fluidr3-native
```

Open http://127.0.0.1:43191. In an active tab, run Verify FluidR3 representatives,
then Verify complete FluidR3 library. The first writes the A/B audio and
representative JSON; the second writes checkpointed full-bank JSON. Both use an
explicit test-only prepared-source opt-in and never enable catalog entries.
Reload before running Run playback verification for the page regression.
Keep the output directory outside the repositories; audio is not committed.
Stop the loopback server afterward.

From fracto-asset-server, using the existing analysis environment:

```powershell
.\.venv\Scripts\python.exe scripts/analyze_fluidr3_audition.py --input-dir D:/temporary/fluidr3-native
```

The analysis writes its spectral/level report and separate level-matched WAV.
Native evidence is copied under this directory; the UI test reports retain copies.

## Issues found and fixed

The test-only audition exporter used ceil for a floating duration whose product
with sample rate was just above an integer. It now rounds to exact frames.

The page regression's zoom assertion included fixed-width labels; it now measures
only the note area, correctly handling a 247px viewport. No product zoom behavior
changed.

The larger catalog exposed a real first-Play race: discovery could stop loading
or playing the unchanged S3 piano when unrelated providers arrived. Refresh now
compares the current routes' effective source cache keys. It preserves ongoing
loading/playback when those sources are unchanged, while assigned-source changes
still stop voices, invalidate preparation/cache and preserve mix settings. Two
new regressions cover discovery during loading and playback. The changed-source
case still verifies stop and explicit replay. Full page regression now passes,
with 10.67ms measured playhead/audio-clock error and all tracked resources cleared.


## FluidR3 library selection (migration step 5)

All Music offers **Sound library** and **Refresh libraries** before loading a file.
All 128 verified FluidR3 GM instruments are enabled; Legacy recordings remains the
catalog and initial UI default. Changing that global default is step 6.

Choosing a library stops playback and pending sample preparation, clears decoded
sample caches, and requires Play again. Unmodified routes use Original MIDI
assignment within the chosen library, including each note's program changes.
Compatible explicit overrides remain assigned even across libraries; the retained
option includes its library name. Mixer settings and parsed file metadata remain
unchanged. New files reset route overrides/mix but retain the selected library for
this mounted page. Leaving the page resets that choice.

Instrument menus show the selected library, GrandB piano fallback, and any retained
cross-library override. Original assignments never silently substitute another
library. Nonzero banks, percussion, missing programs, and excluded silent keys
remain unavailable; choose a supported explicit override when appropriate.
Catalog refresh retains the selection if playable, otherwise uses the catalog
default. Failed discovery retains the last usable registry and fallback piano.
Audio stays lazy: only the song's required chunks download on Play.

Validation: 115 MIDI unit/integration tests, production build, targeted lint,
29 asset-server tests, full catalog integrity verification (149 enabled instruments),
and native Chromium 48 kHz library switching/GM flute output/Stop/refresh/replacement/
cleanup checks. The original full-library sample verification still applies to the
unchanged audio assets. Human quality ranking and other browsers are not certified.
Step 6 native full-page regression passed with FluidR3 default/original assignment and zero remaining resources. Report: fracto-ui/test/midi_reports/fluidr3-default-library.json. Initial Play waits for catalog discovery; sustained mixer measurements explicitly select Legacy.
