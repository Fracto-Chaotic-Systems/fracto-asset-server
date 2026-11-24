# Material search and construction metadata v1

Portable asset.json records remain authoritative. Search reconciles the registry
and uses its active material membership; a configured registry failure never
falls back to a filesystem list. No migration is needed. The data projection
keeps membership, names, categories and descriptions. Tags/construction facts
remain in portable records and are excluded from provenance registration bodies.

`material_search.js` reads at most 2,000 indexed records, four at a time, sharing
one in-flight scan across concurrent queries. A shared 15-second abort deadline
bounds registry traffic and is checked between local file batches. Excessive
catalogs fail rather than silently returning a partial search. Larger libraries
will need an indexed data-service search contract. There is no embedding model.

## HTTP contract

GET `/:id/construction/runtime?revision=<64-hex>` returns exactly
`{material,runtime:{id,model,format,resources}}` for construction rendering. It
inherits the same authorization/no-store policy. The requested digest must match
the current material record; mismatches return 409 material_revision_changed.
Missing/archived/non-material records return 404; invalid queries return 400;
unavailable storage/registry returns 503. Resources are validated registered
relative paths (at most 2,000), not machine paths; model must be declared among
them. Existing file-serving containment/allowlists still apply. There is no
arbitrary file access, automatic latest-revision substitution or historical store.
Clients select an explicit registered color image for a floor texture.

Routes inherit enabled-user authorization when configured, trusted mutation
origins, no-store responses, bounded parsers and sanitized errors. The existing
UI `/api/environment-catalog` transport proxy supports all these routes.

GET `/environment-catalog/materials/search` accepts only optional query fields:

- q: at most 200 characters/12 words; empty browses all materials.
- category: exact descriptive category or slash-delimited prefix, at most 64
  characters (e.g. vegetation/grass).
- placement: ground, floor, wall, ceiling, free or unknown.
- limit: integer 1–50 (default 10); offset: integer 0–2000 (default 0).
- snapshot: catalog SHA-256 from the first page, required for nonzero offsets.

Response: `{contract_version:1,query,snapshot,total,materials,unmatched_terms,
next_offset}`. A material contains exactly id, revision, name, category,
description, tags, construction, missing_metadata, placement_ready and score.
Revision is the current portable record's SHA-256 for component document pins.
No source paths, attribution, account data or arbitrary extensions are returned.

All words must match. Unicode-normalized case-insensitive words match names
(weight 8), tags (6), categories (4) and descriptions (1). Basic regular plurals
are normalized and prefixes of at least three characters match. Ties sort by ID.
There are no semantic synonyms or language-model calls. unmatched_terms reports
words absent from candidates after filters; an empty unmatched list with zero
results can mean no single material matches the whole combination. Paging assumes
unchanged query/filters. A changed catalog snapshot returns 409; restart search.

GET `/:id/construction` returns `{material}` with the same facts without score.
PATCH `/:id/construction` accepts exactly `{revision,description,tags,construction}`.
Description is at most 10,000 characters. Tags are at most 32 nonempty strings
of at most 64 characters, deduplicated/lowercased. The existing atomic catalog
writer and per-asset queue preserve attribution/resources/unknown stored fields,
enforce revision checks and append update-construction-metadata history. No-op
saves preserve the digest. The older catalog PATCH also accepts these optional
allowlisted metadata fields. Resources and source files are never rewritten.

400 invalid_material_query/invalid_material_metadata (or existing invalid_record);
404 missing/archived/non-material asset; 409 stale edit or search snapshot;
413 oversized body; 503 unavailable library/registry or inconsistent membership.
Existing auth failures apply. No automatic mutation retry: disk and database are
not one transaction, so reload/review after uncertain saves. A later read/search
reconciles the projection. Search candidates are operational catalog data; there
is no new identity/profile API payload.

## Construction facts

The SDK validates exact v1 construction keys:

| Field | Meaning |
| --- | --- |
| schema_version | 1 |
| kind | unknown, model or surface |
| source_units | null, m, cm, mm, ft or in |
| meters_per_unit | null or positive source-unit conversion |
| dimensions_m | null or source-axis [X,Y,Z] extents in meters |
| up_axis / forward_axis | null or signed x/y/z axes; perpendicular when known |
| ground_anchor_m | null or source-axis [X,Y,Z] target anchor in meters |
| footprint_m | null or oriented stage-XZ [width,depth] in meters |
| texture_size_m | null or physical [width,height] of one UV tile in meters |
| placement | unknown, ground, floor, wall, ceiling or free |

Known unit names must match their standard conversion. A null name may accompany
an explicit custom conversion. Orientation maps authored up to stage +Y and
forward to +Z, right-handed. Dimensions/anchors use the original model origin
after unit conversion, before preview centering/orientation. Footprint is after
orientation; align the ground anchor to the stage placement target. Actual
transforms are implemented in step 3. Dimension components may be zero for planar
geometry, but not all zero. Footprint/tile extents are positive. Coordinates and
extents are bounded to 10,000 meters; conversions are positive/bounded.

Legacy facts remain null/unknown. Metadata is explicitly curated; optional
read-only Blender inspection and opt-in stage-loader verification support that
review. There is no inferred real-world scale or automatic metadata publication.
See [the completed vegetation/dirt calibration](CALIBRATION.md) for measured
default-pose bounds, explicit game-scale choices and source-preserving repairs.
Readiness means required values are present, not independently verified collision
or measurement evidence. Models require kind, placement, conversion, dimensions,
axes, anchor and footprint. Surfaces require kind, placement and tile size.
Missing fields are returned so a future construction agent can request calibration.
