# Standard kit verification (step 4)

Standard is `playback_verified` and remains `enabled:false`. The percussion
library stays audited. Production MIDI percussion routing, short note-off
handling, runtime choke groups and kit assignment belong to the next steps.

## Evidence

- `standard-source-verification.json`: all 268 hit windows match fresh renders
  from the pinned SF2 and FluidSynth renderer byte for byte. All 61 source notes
  and the 47 core GM percussion source-family mappings pass. The longest tail
  is 16.509 seconds; no tail was cut by a render cap.
- `standard-browser-verification.json`: initial native Chromium verification.
  All 23 chunks decode at both 48 and 44.1 kHz, giving 536 bounded hit cases.
  Every hit is finite, nonzero, unclipped and silent after its playback window.
  All 7,747 note/velocity lookups resolve to the expected 268 prepared windows.
- `standard-browser-post-verification.json`: repeat against the catalog after
  recording verified status. Real-time simultaneous hits, silent Stop, replay
  without another fetch, natural completion and complete cleanup pass.
- `standard-midi-regression.json`: existing melodic MIDI playback, mixing,
  instrument changes, synchronization and unmount cleanup pass unchanged.
- `standard-http-verification.json`: authenticated catalog, HEAD/range audio
  responses and catalog revalidation pass for all 1,458 audio URLs.
- `standard-verification.json`: checksum-bound source and initial browser ledger.
  Initial reports bind the pre-verification catalog; post-verification reports
  bind its new revision. The audio files and render manifest are unchanged.

Source-family checks verify provenance, not subjective sound quality. For
example, the source maps GM open hi-hat to its Half-Open sample and high bongo to
Bongo Rim. A labeled audition covers all 47 core GM notes plus the extended bell
 tree. Human listening quality is not certified by these automated checks.

Reference SF2 open/closed hi-hat choking reduces the late open-hat tail from
RMS 0.000297 to zero. This is a source reference check; it does not certify a
production runtime choker. Real-time browser verification uses a test-only
bounded-hit adapter, not a production percussion provider. Velocity selection
is verified; continuously varying velocity response remains an approximation
between the prepared representatives.

## Reproduce

From fracto-asset-server, using Python with numpy and soundfile installed:

```powershell
python scripts/verify_standard_kit.py --audition-dir PATH_TO_OUTPUT
npm run test:instruments
python -m unittest discover -s test -p '*_test.py'
npm run instruments:probe-http -- --output instruments/fluidr3-percussion/standard-http-verification.json
```

From fracto-ui, run `npm run test:midi`, the production build, and the browser
fixture in `test/midi_browser/serve.mjs`; click **Verify Standard drum kit** and
**Run playback verification**. Keep the tab active for real-time audio capture.
The fixture writes JSON reports and WAV captures to its supplied output directory.
Source and renderer caches are required for fresh reference renders.

Validation: 127 MIDI tests, 36 server tests, 38 Python tests, targeted lint and
production UI build pass. The build retains its existing chunk-size advisory.
An identical importer rerun reuses every file, preserves verified status and
leaves catalog bytes unchanged.

Step 5 subsequently enabled Standard and connected production percussion playback. The disabled-state reports above are historical; see [current playback support](PLAYBACK.md).
