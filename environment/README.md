# Environment asset ownership

The asset service owns the environment library, folder import, Blender conversion,
catalog edits and registered preview delivery at `/environment-catalog`.
`routes.js` applies authentication, trusted UI mutation origins, bounded parsers
and sanitized errors. `catalog.js` owns revision checks, allowlisted attribution
edits, atomic JSON publication, per-asset edit queues and resource containment.
`import.js` preserves originals/checksums, validates ZIP expansion using the SDK,
serializes imports and publishes staged folders under the selected model tier.
`library_paths.js` keeps that publication directory within the canonical library,
including when local symlinks/junctions are present. `blender_conversion.js` runs
Blender with auto-execution disabled and bounded time/output, producing a separate
GLB through this service's Python scripts. It never saves the original model.

`registry_client.js` uses the data service's internal API, never SQL or filesystem
access to another service. Only the SDK's explicit provenance contract crosses
the boundary. Production uses `FRACTO_INTERNAL_SERVICE_TOKEN` (inherited from the
supervisor); an unauthenticated lab permits loopback service traffic only.
`FRACTO_DATA_PORT` selects the loopback data service, default 3002. Registration
has a 15-second timeout. No provenance or credentials are logged.

The default library is `../models`; `FRACTO_ENVIRONMENT_CATALOG_DIR` overrides
it for existing installations. The service-owned library is named `models/`;
model and metadata contents are preserved when moving an existing library to
this location. `models/ingredients/` holds simple reusable pieces,
`models/composites/` holds combined macro-scale objects, and
`models/environments/` holds complete playable scenes. One root `catalog.json`
indexes all tiers; record-relative paths and stable IDs preserve preview/save
URLs when an asset moves between tiers. Existing
deployments with external storage should keep the override pointing to that store;
do not initialize a second empty library. Compose mounts the service-owned library.

JSON remains the portable editable authority. Metadata reads/listing reconcile
the database registry; successful imports and edits include registration. A
database/service failure returns 503; already-published files remain intact and
the next read/list or `npm run environment:register` retries. Disk and MySQL do
not share a distributed transaction. Preview file requests do not touch MySQL.
Database rows are a queryable projection and should not be edited directly.

The UI retains `/api/environment-catalog` as a transport proxy for both Vite and
static hosting. It forwards to this service; it holds no catalog business logic.
The API routes and revision/error semantics are unchanged for browsers.

Shared contracts, ZIP validation and authorization helpers are imported through
`@fracto/sdk` package subpaths. There are no relative root or other-service imports
in these modules. The data service owns the registry's documented HTTP contract.

Model lists now use database membership and names via the private paginated GET
registry contract. `/environment-catalog?category=material|component|area` filters
the shared table; omitting category lists all entries for compatibility. Before
querying, portable records reconcile their registry rows. File records supply
preview resource allowlists, not list membership. Missing DB access fails with
503 rather than returning the filesystem list. Standalone stores without a
registry are retained for offline maintenance/tests.

Imports accept manifest `model_category`, default material for older clients.
They publish under ingredients/composites/environments respectively, with global
IDs but category-specific duplicate detection. Legacy records infer construction
category from their indexed folder; existing grass imports are materials.


Logical folder_path metadata is independent of physical library paths. The SDK
projects it to catalog views and registry registrations; listing summaries use
the database column. PATCH accepts an optional folder_path alongside the existing
attribution/note payload and expected revision. A folder edit atomically updates
asset.json, appends a move-folder history entry and synchronizes the database.
Omitting folder_path preserves it; an explicit empty string moves the asset to
its category root. Invalid paths fail with 400 invalid_folder. No model resources
or directories move, and file-serving allowlists are unchanged.

## Persistent logical folders

The data service owns model_folders (migration 022), keyed by model_category and
folder_path. Empty folders are independent of asset rows and survive moves and
reloads. Asset folder assignments remain in environment_assets and asset.json;
these logical paths never relocate model resources.

Contract v1: authenticated internal GET /internal/environment-assets/folders
requires category=material|component|area and returns {folders: [path, ...]}, up
to 1,000 entries, including folders referenced by existing assets. POST to the
same endpoint accepts only {category, folder_path}, with a nonempty SDK-normalized
path (eight levels, 64 characters per level, 512 overall), and returns
{folder_path}. Creation is idempotent; retries do not duplicate records. Invalid
input is 400, unavailable persistence is 503; normal internal authentication
applies before parsing. The asset service exposes matching GET/POST
/environment-catalog/folders endpoints under its existing user/origin policy,
and forwards via the registry client with a 15-second timeout. UI same-origin
/api/environment-catalog/folders is a thin proxy. Folder names are case-sensitive.
Move uses the existing revision-checked asset PATCH contract, preserving
attribution and appending move-folder history. Conflicts return 409 and leave
the editor's selection intact for review.
