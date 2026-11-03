# FluidR3 percussion source audit — step 1

Current release: **Standard is verified and enabled for MIDI percussion playback and kit assignment.** See [release/install/rollback](RELEASE.md). Other kits remain disabled. Earlier sections preserve the source audit and preparation stages.

Historical step-1 state, audited 2026-11-02: **No percussion audio was imported or enabled at that stage.** Step 2 now publishes the audited kit metadata; see [catalog schema](../DRUM_KITS.md). The source-audit findings below record step 1; melodic samples and playback remain unchanged.

## Selected source and identity

Use the original `FluidR3_GM.sf2` from the PianoBooster Fluid SoundFont v3.1 release.
Start with internal SF2 bank 128, program 0, preset name **Standard**. The existing
melodic library remains the separate, pre-rendered MIDI.js distribution.

- Repository: https://github.com/pianobooster/fluid-soundfont
- Git tag: `v3.1`; resolved commit: `24c5c8a82e2f2cec2497710c6a72e5ccfeca40cd`
- Git tree: `700b2ed1440eb85e6e91a01dc5fc946561e6cf91`
- Release ID: 35191848; asset ID: 29477752; published 2020-12-12T17:59:00Z.
- [Binary](https://github.com/pianobooster/fluid-soundfont/releases/download/v3.1/FluidR3_GM.sf2): 148,398,306 bytes.
- SHA-256: `74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0`

The SF2 is a release asset outside the Git tree. Tag/commit alone does not secure
its bytes: the audit always enforces the fixed byte count and SHA-256, including
cached/offline runs. The initial digest is an observed source pin, not an upstream
cryptographic signature. Original bytes stay in ignored `source-cache/`; tracked
metadata and notices are sufficient to identify/recover them. Source-lock records
notice Git blob IDs, SHA-256s, exact URLs and the inventory digest.

## License and creator evidence

The pinned original README explicitly releases Fluid under MIT. COPYING retains
Frank Wen's copyright and permission notice, and the SF2 itself identifies Frank
Wen, credits Frank Wen/Toby Smithe in ICOP, and states MIT in ICMT. The repository
says these files came from Ubuntu. Exact supplied README, COPYING and repository
README.md are retained under `upstream/`. Preserve all supplied notices with any
prepared samples; contributor names remain in the original README.

This evidence applies to this original SF2 distribution. It does **not** rewrite
the CC BY 3.0 US declaration retained for the existing MIDI.js-rendered samples,
nor establish that the original renderer used this exact SF2 binary.

## Measured source findings

- SoundFont format 2.1; 189 presets, including 31 bank-128 drum kits; 1,418 sample headers.
- All percussion zones reference 209 distinct effective raw sample windows.
  Every window has finite PCM16 data and nonzero signal; sample rates are 32,000
  or 44,100 Hz, with raw durations about 0.010–8.522 seconds. These are source
  windows, **not rendered hit lengths** or assurances that a hit sounds correct.
- Standard contains 149 effective regions and non-silent structural coverage for
  notes 27–87 at every velocity 1–127. All 47 core GM percussion notes 35–81 are
  represented. Extended notes outside that core need explicit names/policy later.
- Some kick/snare zones have multiple velocity bands reusing the same PCM with
  different generators. Do not describe these as independently recorded layers.
  Preserve the generator settings and renderer behavior when preparing samples.
- Standard exclusive class 1 groups notes 42/44/46 (hi-hats); class 4 groups 78/79;
  class 5 groups 73/74/80/81; class 6 groups 86/87. These are observed SF2 values,
  not newly invented choke rules. Choking must be scoped to the kit/route and
  must not silence sibling left/right voices from the same hit.
- Standard raw loop mode 1 occurs on notes 81 and 84. Raw PCM extraction cannot
  reproduce the preset envelope, filtering, tuning, panning or modulator behavior.
  A later importer should render through a pinned SF2 synthesizer with explicit
  velocity, note-off, release-tail and loop policy, producing finite hit assets.
- **176 referenced stereo-type windows have nonreciprocal sample-link metadata**
  (many links are zero). All references/bounds are in range. Preserve this finding:
  do not pair channels by sample_link or names alone, or silently repair the SF2.
  Verify a selected offline renderer's zone/pan output before importing Standard.
- TR-808 lacks structural coverage for core GM notes 58, 65 and 66. Inventory
  records each kit's gaps; alternate kits must not inherit Standard's coverage.

`kit-inventory.json` retains every effective percussion region's key/velocity
ranges, inherited preset/instrument generators, sample bounds/loops, PCM digest,
source amplitude/tail metrics, and all pdta table digests (including modulators).
The audit does not interpret modulator synthesis or certify audible identities.
See [kit summary](KITS.md) and [audit summary](audit-summary.json).

## Alternatives considered

`source-candidates.json` pins the pre-rendered repository
`henrikvilhelmberglund/midi-js-compat-soundfonts` at
`b58f4fea83d47e9564f1008ac916e0e6ea378d58`. It contains one Standard bundle and
61 individual MP3s (notes 27–87), but no supplied license notices or pinned SF2/
render configuration; the bundle assigns itself to `MIDI.Soundfont.marimba`.
It is not selected. Bundle bytes/Git hash are recorded, but its audio was not
decoded or certified. No upstream JavaScript is executed by this audit.

## Reproduction and next-step boundary

Python is an offline maintenance dependency only. Use the existing analysis
requirements (`numpy`); no browser/Node playback dependency is added.

```powershell
# From fracto-asset-server, after installing scripts/instrument-analysis-requirements.txt:
.\.venv\Scripts\python.exe scripts/audit_fluidr3_percussion.py
# Recheck locally cached binary and supplied notices without network:
.\.venv\Scripts\python.exe scripts/audit_fluidr3_percussion.py --offline
.\.venv\Scripts\python.exe -m unittest discover -s test -p '*_test.py'
```

`--output-dir PATH` isolates audit artifacts. Bounded downloads are checked before
cache publication. A mismatched cache fails; it is never silently overwritten.
Offline runs are deterministic. The 148 MB SF2 and alternative bundle remain
ignored; no generated playback assets exist yet. All 28 Python tests pass.

Step 2 can now model explicit kit identity/program/note coverage and source choke
metadata. Step 3 should pin an offline SF2 renderer and its configuration rather
than treat this file as an MP3 note dictionary. Browser audio/Standard sound-map
verification belongs to step 4; the source is not marked playback-ready here.

References: [GM specification](https://midi.org/general-midi-level-1),
[FluidSynth generator definitions](https://github.com/FluidSynth/fluidsynth/blob/master/include/fluidsynth/gen.h),
[original source release](https://github.com/pianobooster/fluid-soundfont/releases/tag/v3.1).
SF2 bank 128 is a synthesizer-internal percussion bank; it must not be blindly
mapped to MIDI CC0 value 128 (MIDI controller data is 0–127).


Step 2 adds the [audited drum-kit catalog](../DRUM_KITS.md): 31 disabled kit inventories in a separate collection, with note/velocity coverage, source choke classes and the melodic-to-percussion library link. No kit audio is served or enabled yet.

Current step 5: Standard is verified and enabled for production MIDI percussion. Other kits remain disabled. See [playback behavior and validation](PLAYBACK.md); the earlier sections preserve each audit/preparation stage.
