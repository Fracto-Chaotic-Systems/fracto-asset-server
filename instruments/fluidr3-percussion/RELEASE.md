# FluidR3 percussion v1

Coordinated local release tag: `release/fluidr3-percussion-v1` in
fracto-ui and fracto-asset-server. This release adds Standard drum playback and
All Music kit assignment; the 149 existing melodic entries and FluidR3 GM
default remain unchanged. Thirty other audited kits remain disabled.

## Runtime behavior and limits

Original MIDI assignments resolve channel 10 (zero-based 9), bank 0:0,
program 0 to Standard through FluidR3 GM's percussion-library link. Standard
covers 61 drum note identities, 27–87, including the 47 core GM notes 35–81.
There are 268 prepared velocity windows in 23 bounded mono 48 kHz PCM16 WAVs.
Velocity response within a window is approximated by gain scaling against its
representative render velocity. No pitch transposition substitutes drum notes.
Unsupported kits, banks, notes and velocities report unavailable.

Select a channel 10 strip in All Music to choose Original or a kit override.
Only verified enabled kits with complete track coverage are selectable. File
program/bank history remains visible; manual overrides preserve drum note
identities and require Play after stopping playback. Mix settings and compatible
manual overrides survive library switches and refreshes. Pitched tracks show
melodic instruments only. Libraries without a percussion link have no automatic
drum mapping; an already selected compatible explicit kit override is retained.

Full finite one-shot tails ignore MIDI note-off/pedal lengths. Exclusive classes
choke earlier hits on the same kit/channel across tracks using a scheduled 5 ms
fade. Repeated hits cannot revive an earlier choke fade. Stable event order determines simultaneous class members. Stop, replacement,
assignment/library changes and unmount cancel active/future voices. Completion
waits for tails. This is bounded-sample playback, not a live SF2 synthesizer.
Prepared tails use a fixed 100 ms source gate; the longest is 16.509 seconds.
The normal 256 MiB song sample-cache budget still applies.

## Install or reconstruct

Git includes the catalog, render manifest, source/renderer pins, tests, evidence
and notices. **Git does not include audio or renderer/source caches.** Preserve
the existing melodic asset store. Add all 23 immutable WAVs listed in
`../indexes/fluidr3-percussion-kit-standard-04cc5ceb2a5e-render.json`, under
`../playback/fluidr3-percussion-kit-standard/<sha256>.wav`.
They total 26,528,042 bytes; the largest decoded chunk is 9,860,316 bytes at 48 kHz.

To reconstruct missing drum WAVs on 64-bit Windows, use Python with numpy and
soundfile (offline maintenance only):

```powershell
python scripts/audit_fluidr3_percussion.py
python scripts/fetch_fluidr3_drum_renderer.py
python scripts/import_fluidr3_percussion.py --apply
npm run instruments:verify
```

The first two commands recover checksum-pinned upstream caches. With complete
caches, use `--offline` for those commands. The importer itself uses no network,
checks every renderer file and version, and preserves verified/enabled state only
for identical regenerated assets. Changed source, recipes or existing immutable
files fail. It does not prune old assets. Do not rerun the step-2 metadata-only
publisher to replace the final activated catalog. See [IMPORT.md](IMPORT.md) for
pins, renderer settings, dependencies and recovery details.

Deploy WAVs and manifest before publishing the matching catalog, then deploy
both updated server and UI code. Keep older registered assets for existing
clients. Verify authorization, the configured asset origin and HTTPS/localhost
for browser checksums. Refresh libraries or reload All Music after deployment.
Runtime needs Node/browser Web Audio only: no Python, SF2, renderer DLL, or
upstream network access. This local release does not deploy or publish remotely.

## Attribution

The original PianoBooster Fluid SoundFont v3.1 SF2 is pinned by SHA-256 and its
upstream commit in `source-lock.json`. Retain the original MIT notices in
`upstream/COPYING`, `upstream/README`, and the source/creator evidence described
in [README.md](README.md) whenever distributing sample data. FluidSynth 2.6.2's
LGPL notice is in `upstream/FLUIDSYNTH-LICENSE`; it applies to the offline renderer,
not as a replacement license for these samples. Renderer binaries are not part
of the runtime release. Existing melodic MIDI.js attribution is unchanged.

## Validation and rollback

135 MIDI, 38 server and 38 Python tests pass; production UI build and targeted
lint pass. The existing build chunk-size advisory remains. Full original/index/
melodic/drum integrity and 1,458 authenticated HTTP HEAD/range checks pass.
All 268 windows match fresh pinned source renders; all 536 native hit cases pass
at 48 and 44.1 kHz. Browser checks cover all 7,747 production velocity lookups,
polyphony, one-tick note-offs, tails, choking, cached replay, silent Stop, natural
completion, kit UI overrides, library changes, refresh, mixing and zero resources
after cleanup. The complete existing melodic browser regression also passes.
Subjective listening quality and the other 30 kits are not certified.
See `release-validation.json` for catalog/pin/evidence checksums. Earlier step
reports retain the state measured at that step, including disabled catalogs.

For a percussion-only rollback prepare a copy of the matching catalog, set
Standard's `enabled` to false, increment `library_version`, validate with
`node scripts/instruments.js verify --catalog-file ABSOLUTE_CANDIDATE_PATH`,
then atomically publish it. Refresh clients; disabled-kit overrides reconcile
to Original, which will be unavailable. Preserve the audio files and existing
melodic entries. Stop active playback during the rollback rollout.

For complete code rollback restore both pre-release commits recorded in
`release-validation.json`, their matching catalog, and asset store together.
Do not use a destructive reset on a checkout containing new work. The coordinated
release tag provides the corresponding forward restore point. No sound data
needs deletion for either rollback path.

The documented disabled-kit rollback candidate also passed full integrity without publication; see release-rollback-verification.json. Final browser reports are retained under release-browser/.
