# Multi-library catalog contract

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


Implemented 2026-11-02, FluidR3 migration step 2. This is an additive extension of
schema_version:1. Legacy library_version:3 describes asset preparation history;
revision remains the checksum of the complete catalog and changes with metadata.

## Library and instrument identity

The catalog and GET /instruments now include:

```json
{
  "schema_version": 1,
  "default_library_id": "legacy",
  "libraries": [
    {
      "id": "legacy",
      "name": "Legacy recordings",
      "version": "1",
      "source_format": "chromatic-mp3",
      "status": "active"
    },
    {
      "id": "fluidr3-gm",
      "name": "FluidR3 GM",
      "version": "044fab8e1456bfafc5776e86dfd6bb8697149aef",
      "source_format": "midi-js-note-mp3",
      "status": "active",
      "license": "CC-BY-3.0-US"
    }
  ]
}
```

Libraries may include validated source_url (HTTP(S), no credentials/query/fragment)
and source_revision (40- or 64-character lowercase hexadecimal hash). Only public
fields are projected; arbitrary extra library fields and filesystem paths are
not returned. IDs are lowercase hyphenated tokens, at most 128 characters;
names/versions/license labels have a 256-character bound. Active and audited are
the supported library statuses. The default library must exist and be active.
Source format describes the input adapter; it does not change delivered WAV format.

Every instrument in an explicit multi-library catalog declares library_id and an
instrument_key identifying that sound within its library. Legacy keys can be
inferred from their existing IDs for compatibility. A nonlegacy instrument's
global ID is library_id + '-' + instrument_key. Both global IDs and the pair
(library_id, instrument_key) must be unique. For example:

| Library | Instrument key | Global instrument ID | Engine provider ID |
| --- | --- | --- | --- |
| legacy | flute | flute | asset-flute |
| fluidr3-gm | flute | fluidr3-gm-flute | asset-fluidr3-gm-flute |

The FluidR3 naming rule is used by the step-3 importer. The library now contains 128 prepared, disabled runtime instruments;
its status becomes active after verified import. Enabled instruments cannot belong to
an audited library. Normal playback continues to require the existing available,
enabled and verification gates; catalog presence does not enable a source.

## Compatibility and resolution

- Older catalogs with no libraries normalize to one active legacy library. Existing
  21 instrument IDs, asset IDs, registered audio paths, URLs and enabled flags stay
  unchanged. The active catalog only adds identity and library metadata.
- GET /instruments/:id/audio/:asset stays unchanged. New globally qualified IDs
  use that same route; no alternate filename/path endpoint is added.
- The engine exposes default_library_id and immutable library metadata. Providers
  retain library_id, instrument_key and their library display name. Existing
  provider IDs and cache key syntax remain; distinct global provider IDs prevent
  cross-library cache reuse even for the same instrument name or audio URL.
- Original MIDI program lookup searches only the default library. It can also
  explicitly resolve with options.library_id; can_assign accepts the same scope
  as its third argument. Explicit provider overrides remain explicit. There is
  no cross-library fallback or implicit program/bank inference. Standard-bank
  checks and percussion restrictions are unchanged.
- GrandB S3 is a legacy provider; it cannot steal a FluidR3 piano program merely
  by being registered first. It remains the current file-load default. Changing
  file-load defaults and exposing library selection are later migration steps.
- Source/default-library identity changes follow existing refresh cancellation,
  cache and assignment rules. Compatible assignments and mixer settings remain;
  metadata-only refresh publishes new library details without stopping playback.
- Legacy seed recovery compares only legacy seed identities, preserves the full
  existing catalog, and does not delete metadata or instruments of other libraries.

## Bounds and import boundary

Both sides permit 16 libraries and 2,048 instruments, replacing the old browser
128-instrument ceiling. The asset server rejects on-disk catalogs above 32 MiB
before reading them, then rechecks the loaded byte length. The browser rejects
oversized declared responses and counts decoded stream bytes up to the same
32 MiB bound, cancelling an oversized stream. WAV chunk and aggregate decoded
memory limits remain 48 MiB-at-48kHz and 256 MiB respectively.

The 9 MiB source audit lock is deliberately a separate document, not a runtime
catalog payload. The source-format-specific MP3 import/index adapter is step 3;
existing timing-grid and bounded-WAV verification remain strict in this step.
Simply attaching library metadata does not make an unconverted FluidR3 bundle
an acceptable recording or playback asset. The schema extension itself does not import or enable samples. Step 3 now
publishes disabled prepared FluidR3 assets; see [fluidr3-gm/IMPORT.md](fluidr3-gm/IMPORT.md).

## Validation

- 109 MIDI tests pass, including old-catalog normalization, invalid
  identities and provenance, duplicate keys, scoped original-program resolution,
  cache isolation, 149-entry catalogs, limits and UTF-8 stream chunk boundaries.
- 25 asset-server tests pass, including real HTTP responses for two libraries
  sharing an instrument key, preserved legacy URLs, private-field filtering,
  ETag/default-library updates, invalid metadata and oversized catalogs.
- Existing real-library verification passes all 25 originals, 183 WAVs and 1,999
  mappings with all 21 existing instruments still enabled. HTTP HEAD/range and
  engine integration probes pass. Lint and production build pass.
- No new native browser audio certification is claimed by this metadata step.
  Prior browser evidence remains attached to the unchanged audio assets.


FluidR3 step 4 verification is complete; see [the native results](fluidr3-gm/VERIFICATION.md). Providers remain disabled until library-aware selection is connected.


Step 2 adds the [audited drum-kit catalog](DRUM_KITS.md): 31 disabled kit inventories in a separate collection, with note/velocity coverage, source choke classes and the melodic-to-percussion library link. No kit audio is served or enabled yet.
