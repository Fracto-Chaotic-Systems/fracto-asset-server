# Drum-kit catalog extension — step 2

Schema version 1 remains additive. Library version 5 adds `drum_kits`, separate
from melodic `instruments`; missing `drum_kits` normalizes to an empty array.
Both server and UI use identical validators. Null/malformed inventories fail closed.

## Identity and source relationship

`fluidr3-percussion` is an **audited**, MIT-licensed SF2 library with its own source
revision. `fluidr3-gm.percussion_library_id` links the existing melodic FluidR3
library to it without changing either source's identity, license or audio URLs.
A percussion link must target an existing SF2 library and cannot recurse.
`source_format: "sf2"` is recognized as metadata, not a runtime download format.
The selected/default sound library remains `fluidr3-gm`.

Each kit has a namespaced ID: `${library_id}-kit-${kit_key}`. Kit IDs must be
unique across both collections. Program/bank combinations are unique within a
percussion library. The first planned kit is `fluidr3-percussion-kit-standard`.
All 31 source kits are inventoried; none is a playable provider yet.

```json
{
  "id": "fluidr3-percussion-kit-standard",
  "library_id": "fluidr3-percussion",
  "kit_key": "standard",
  "kind": "drum-kit",
  "name": "Standard",
  "midi_program": 0,
  "midi_bank": {"msb": 0, "lsb": 0},
  "source_preset": {"bank": 128, "program": 0},
  "source_sha256": "74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0",
  "enabled": false,
  "verification_status": "source_audited",
  "coverage_status": "source-audited",
  "playback_mode": "one-shot",
  "notes": [{"midi_note": 42, "velocity_ranges": [[1, 127]]}],
  "choke_groups": [{"source_exclusive_class": 1, "midi_notes": [42]}],
  "recordings": [],
  "playback_assets": []
}
```

The example shows one note; the actual Standard entry contains 61 notes (27–87)
and the complete observed choke groups, including 42/44/46 for hi-hats.
`midi_program` is zero-based (0–127), separate from melodic program selection.
For this initial GM mapping only MIDI bank 0:0 is declared. Internal **SF2 bank
128 is not MIDI CC0=128**; controller values must stay within 0–127.

## Note and choke metadata

`midi_note` is the MIDI drum identity, not a pitch to transpose. Notes are unique
and sorted in 0–127. Velocity ranges are sorted, disjoint inclusive intervals in
1–127. They describe the union of source-audited playable velocities, not rendered
sample layers; the full source inventory retains the generator/velocity splits.
No missing notes are filled from another kit. In particular, TR-808 does not claim
notes 58, 65 or 66. Short note-off behavior, tails and actual hit identities remain
unverified until rendered assets have been prepared and auditioned.

Choke groups retain `source_exclusive_class` (1–127) and sorted unique mapped
notes. Unknown notes, duplicate classes and ambiguous multiple-group membership
are rejected. These are source observations. They do not activate choking in the
player. `playback_mode: "one-shot"` declares the intended finite-hit asset contract;
source loops/envelopes must be rendered explicitly in step 3. Future choking must
be scoped to kit/route and must not choke sibling voices from the same hit.

## Playback gate and API

This step accepts only disabled `source_audited` kits, with empty `recordings` and
`playback_assets`. Changing an enabled/status flag or inserting assets is rejected
until a later implementation supplies the asset-validation contract. Audited
library status also prevents selection. Placing a kit in `instruments` is invalid;
no kit can accidentally become a melodic provider, including verification opt-in.
The channel-10 engine behavior remains unsupported pending steps 3–6.

`GET /instruments` adds whitelisted `drum_kits` metadata and the library link.
Every audited kit reports `available: false`, `available_notes: []`, and empty
recording/playback arrays. Source coverage is exposed separately as `notes`.
Private file paths/generator/audit internals are not published. The SF2 is not
registered as a runtime audio asset. Requests for unregistered kit audio return
404 using the existing route policy; melodic URLs and authorization stay intact.
Limits: 256 kits, 128 notes per kit, 127 velocity intervals/choke groups, and the
existing 2,048 combined-instrument and 32 MiB catalog bounds.

## Reproduce and extend

```powershell
# From fracto-asset-server; no audio download or SF2 execution:
.\.venv\Scripts\python.exe scripts/catalog_fluidr3_percussion.py
.\.venv\Scripts\python.exe scripts/catalog_fluidr3_percussion.py --apply
npm run instruments:verify
npm run test:instruments
.\.venv\Scripts\python.exe -m unittest discover -s test -p '*_test.py'
# From fracto-ui:
npm run test:midi
npm run build
```

The command checks the pinned source identity and inventory checksum, preserves
all melodic entries and the default, and uses the existing validated atomic
publication helper. Identical reruns are no-ops. It refuses to reset differing,
imported or enabled kit state. The source SF2 cache is not required for metadata
publication. `--library-dir PATH` supports an isolated candidate library.

Deploy the compatible UI validator with this catalog extension. Old clients that
reject new source formats should reload the updated UI; previously prepared audio
remains registered. Future work: render Standard kit assets with a pinned SF2
renderer, validate their coverage/tails/velocity layers and only then extend the
catalog's activation gate and wire percussion providers and assignment controls.

Validation: 124 MIDI tests, 32 server tests, 31 Python tests, UI build and targeted lint pass. Full existing asset integrity passed before atomic publication. The HTTP probe validates 31 unavailable kits plus all 1,435 existing audio URLs. Evidence: fluidr3-percussion/catalog-validation.json and catalog-http-verification.json.


Step 3: [prepared percussion assets](fluidr3-percussion/IMPORT.md) add Standard kit render manifests, bounded note/velocity hit chunks and sanitized authenticated WAV URLs. Assets may be available while kit playback remains disabled. This supersedes the step-2 empty-assets-only gate; no percussion provider is enabled yet.

Step 4: [Standard verification](fluidr3-percussion/VERIFICATION.md) records source/native playback evidence. Standard is playback_verified but disabled pending production MIDI percussion integration.

Step 5: [production percussion playback](fluidr3-percussion/PLAYBACK.md) enables verified Standard only, via the FluidR3 melodic library link. Activation requires playback_verified status, valid bounded assets and an active SF2 source library.

Step 7: [release, reconstruction and rollback](fluidr3-percussion/RELEASE.md) records final validation and coordinated local tag release/fluidr3-percussion-v1.
