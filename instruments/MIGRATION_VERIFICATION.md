# Instrument migration verification and operations

Current playback status (2026-11-02): **all 21 instruments are enabled** after
75 native Chromium decode/render probes (low/middle/high pitches of every
recording layer) passed through the sample cache and voice engine at 48 kHz.
The catalog marks them playback_verified; detailed evidence is recorded in
browser-verification.json in the asset-server instruments directory. Earlier
disabled/pending statements below describe the initial migration stages.
Native probes confirm signal output, not a subjective listening review.
Reload All Music to fetch the updated catalog. A source can still be disabled
for a track containing notes outside that instrument's verified pitch range.


Verified 2026-11-02 against library version 3, catalog revision
`e929b2703edbf3e657861fd38e6b17f73a588c372cfb3c62b818deffc213c99d`.
The asset server now owns the recovered instrument library and read-only audio
endpoints. All Music discovers that catalog, displays its inventory and resolves
playable providers through the MIDI engine. GrandB S3 remains the default.

## Results

| Check | Result |
| --- | --- |
| UI parser/timing/scheduler/cache/mixer/assignment tests | 103 pass |
| Asset server seed/index/playback/HTTP tests | 22 pass |
| Python pitch analysis and asset generation tests | 11 pass |
| Shared service authorization tests | 5 pass |
| Original integrity | 25 MP3s, 407,310,721 bytes, checksums match |
| Generated integrity | 183 mono WAVs, 1,370,601,654 bytes, checksums match |
| Independent source alignment | All 1,999 note interiors pass; max PCM error 0.0000152587890625 |
| HTTP probe | All 208 URLs: HEAD + 32-byte ranges match; catalog revalidates with 304 |
| Real HTTP engine probe | 21 entries / 1,999 mappings; one flute fetch/decode for four voices; replay reuses cache |
| UI lint and production build | Pass; existing large-bundle advisory remains |
| Full Chromium page harness | Pass: zoom/fit, labels, narrow pane, 64 tracks, 10,000 notes, follow and suspended clock |
| Browser mixer and assignments | Pass: stereo pan/volume, mute/solo, 21 disabled inventory entries, assignment stops, mix retained |
| Native flute browser check | Pass at 48 kHz: four shared-buffer voices, one fetch, RMS 0.03068; exact Stop/boundary silence |
| Browser cleanup | Zero frames, intervals, open contexts, connected product nodes or source callbacks |

The capture worklet now records zero-channel input as rendered silence, so
source disconnection cannot create missing PCM intervals. The boundary assertion
waits for worklet messages before measuring. A regression test covers this case;
no product scheduler or sound-source gate was changed during final verification.

The browser's full page run measured 0.01867 seconds playhead/audio-clock error
against the 0.12-second tolerance. Stop, replacement and assignment changes
produced exact zero captured output. Replay and natural completion passed.
Earlier browser access failures and the earlier zoom assertion failure remain
historical observations; this run passed those rendering checks.

The deterministic engine probe checks actual HTTP/checksums/WAV headers with a
stub decoder and clock. It does not prove browser decoding. Browser recordings
capture the graph sent to AudioDestination, not physical speakers, OS volume or
human assessment of instrument quality. Only Chromium at 48 kHz was exercised;
other browsers and sample rates have unit coverage but no native certification.

## Reproduce

From fracto-asset-server, recover the pinned source Git objects and generate the
ignored assets; neither a checkout nor the tracked manifest contains audio:

```powershell
npm run instruments:seed -- --source-repo D:/mediaplex/react-apps
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/instrument-analysis-requirements.txt
.\.venv\Scripts\python.exe scripts/index_instruments.py --apply
.\.venv\Scripts\python.exe scripts/prepare_instrument_assets.py --apply
npm run instruments:verify
npm run test:instruments
.\.venv\Scripts\python.exe -m unittest discover -s test -p 'instrument_*_test.py'
.\.venv\Scripts\python.exe scripts/verify_instrument_assets.py --output instruments/playback-verification.json
npm run instruments:probe-http -- --output instruments/http-verification.json
```

From fracto-ui:

```powershell
npm run test:midi
node test/midi_asset_engine_probe.mjs --output D:/temporary/asset-engine.json
npm run build
node test/midi_browser/serve.mjs D:/temporary/midi-browser
```

The output parent directory must exist for the engine probe. Open the harness at
http://127.0.0.1:43191. Reload before each run. Run playback verification checks
the page and fallback; Run asset-engine verification uses an explicit test-only
prepared-source opt-in without changing catalog flags. The latter checks native
flute decoding, shared polyphony, a long note's 7.87-second boundary, Stop and
cleanup. Keep the tab active if its browser suspends the audio clock. Stop the
loopback process afterward. Do not use these test-only fixtures as a public server.

## Runtime setup and recovery

- Store catalog.json, indexes/, originals/ and playback/ together on persistent
  asset-server storage (about 1.78 GB of audio). These audio directories are ignored
  by Git. Provision or copy them separately and run instruments:verify there.
- Set FRACTO_INSTRUMENT_DIR to the absolute library root if using external storage.
  Do not point it at a directory containing only the original MP3s.
- Optional FRACTO_ASSET_PUBLIC_URL is an HTTP(S) origin/path prefix. Otherwise the
  catalog emits /instruments/... URLs; the UI preserves /api/asset when proxied.
  Configure the runtime asset service origin through the existing service ports.
- Existing enabled-user/session or internal-token authorization and credentialed
  CORS remain in force. Never put internal service tokens into the UI. The browser
  must have a permitted origin and session; Web Crypto requires HTTPS or localhost.
- Catalog discovery failure keeps GrandB available and shows a nonblocking message.
  Reload the page after repairing configuration. Audio integrity/decode failures
  require an explicit Play retry. Missing/tampered files must be recovered, not
  bypassed by changing hashes. Seed/generation reruns reuse matching files and
  refuse conflicting content; no destructive cleanup is performed automatically.
- Roll back catalog and its referenced immutable assets together, then verify and
  reload All Music. Keep previous content-addressed assets during deployment;
  stale version URLs are deliberately rejected rather than serving changed bytes.

## Deliberate limits

All 21 entries remain enabled:false with assets_prepared status. The catalog's
library-wide browser_verification remains pending: a flute probe does not certify
all sources. Sources need representative low/high pitches, layers, native decode,
output and subjective quality checks before playback_verified / enablement is
published. Original creator/usage terms remain unknown; this work makes no new
license assertion. No automatic GM program/bank mapping is inferred from names.

Assignments are per track/channel and reset with a new file. Mute does not bypass
unsupported-note validation. Notes do not loop; long notes decay at the registered
window and produce a warning. Chunks are mono; MIDI pitch bend and CC volume/pan
expression automation are retained as metadata, not applied to synthesis.
The cache preflights decoded size at the actual audio rate and rejects songs over
256 MiB. Scheduling uses browser timers and can miss notes under background
throttling. No production service deployment or catalog enablement is part of
this verification step.

Enablement follow-up: all 21 providers now pass native representative rendering
and are enabled. The assignment browser check confirms all 21 options match
the catalog, selects Flute, measures nonzero output, retains mix settings and
closes the context on unmount. The initial hidden-tab audio check did not produce
a valid measurement; the active-browser run passed.
