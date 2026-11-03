# Percussion playback (step 5)

Standard is now enabled in the active `fluidr3-percussion` source library.
The selected `fluidr3-gm` melodic library points to that source through its
`percussion_library_id`. Other 30 kits remain disabled. Default melodic library,
149 melodic instruments and all audio asset bytes are unchanged.

Channel 10 (zero-based channel 9), bank MSB/LSB 0/0 and program 0 resolve to
Standard when Original MIDI assignment is used. Unsupported programs, banks,
notes or velocities fail explicitly; no melodic patch or alternate kit is
substituted. SF2 libraries are kit sources, not selectable melodic libraries.
Kit assignment controls remain step 6.

The provider selects the exact note/velocity window from the verified bounded
WAVs, retaining authenticated URLs, checksums, decode bounds and shared-chunk
cache keys. Gain is velocity divided by the chosen render velocity: source
velocity response is already baked into the sample. This approximates response
inside a prepared interval without applying velocity twice.

Drums use full finite one-shot tails, ignoring MIDI key release and sustain
lengths. The baked attack remains intact. The scheduler waits for tails before
completion, skips expired windows after scheduling delays, and Stop, reload,
assignment/library changes and disposal cancel both active and future sources.

Exclusive classes are scoped to kit and MIDI channel, across tracks. A later
hit cuts earlier hits in its class with a 5 ms fade scheduled on the audio clock,
not when the lookahead pump runs. Repeated hits in a class choke each other;
simultaneous hits follow stable MIDI event order, with the last hit surviving.
Other classes/kits remain polyphonic. This bounded-sample policy approximates
SF2 exclusive-class behavior; it does not run an SF2 synthesizer in the browser.

## Validation

132 MIDI tests, 38 server tests and 38 Python tests pass. UI build and targeted
lint pass; existing build chunk-size advisory remains. Full source, index,
melodic playback and drum integrity pass before atomic catalog publication.
HTTP verification covers all 1,458 audio URLs with exactly one enabled kit.

`percussion-browser-verification.json` exercises the production registry,
cache, controller, scheduler, voice and mixer with native Chromium audio.
It verifies all 7,747 Standard note/velocity lookups, audible captured output
past one-tick note-offs, hi-hat tails/choking, natural completion, replay without
fetches, silent Stop and zero resources after disposal. Native offline audio
compares open-hat and choked late tails across tracks. These are signal and
lifecycle checks; subjective listening quality is not certified.
`percussion-midi-regression.json` records the existing melodic browser suite.
`percussion-http-verification.json` binds HTTP checks to the activated catalog.

To repeat, run the MIDI/server/Python test commands from the step-4
[verification guide](VERIFICATION.md), then start the UI browser fixture and
click **Verify production percussion** and **Run playback verification**.
The fixture saves JSON evidence and a WAV capture. Deploy the updated UI,
asset-server code, catalog and existing prepared Standard assets together.
Refresh the All Music catalog or reload the page after updating the server.
Earlier step-4 disabled-state evidence remains historical and unchanged.
