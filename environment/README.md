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

## Model tree management (additive v1)

Public POST /environment-catalog/manage uses the existing enabled-user and trusted
mutation-origin policy and 128 KiB JSON limit. The UI uses the thin same-origin
/api/environment-catalog/manage proxy. SDK FractoModelManagement.js validates:

- rename-model: {action,id,revision,name}; name is trimmed, nonempty, at most 255
  characters, without controls. IDs remain stable; geometry/source paths do not move.
- delete-model: {action,id,revision}; revision is the current 64-hex catalog digest.
  Deletion is a retained-file archive (asset.json archived:true), recorded in history.
  Deleted models are excluded from inventory and resource/metadata GET returns 404.
- rename-folder: {action,category,folder_path,name}; name is one valid folder segment.
  All active descendants in that category receive the new prefix. Definition
  collisions and paths exceeding SDK depth/length bounds are rejected before writes.
- delete-folder: {action,category,folder_path}; only empty folders can be deleted,
  including no nested folder definitions. No contained model is implicitly deleted.

Unknown fields fail 400 invalid_record; invalid folder paths are 400 invalid_folder.
Stale model revisions are 409 file_conflict. Folder conflicts, missing folders and
nonempty deletion are 409 folder_conflict/folder_not_found/folder_not_empty. Success
is 200 {id} for models or {folder_path,target?} for folders; unavailable services
return 503 catalog_unavailable. Tree operations are queued in the asset process;
normal catalog edits retain per-model revision checks. There is no automatic
mutation retry. Refresh and review after a timeout or conflict.

The asset service owns portable record changes and compensates completed folder
edits on failure without overwriting newer revisions. Files and SQL are not one
distributed transaction: external edits or an uncertain final database response
may require reviewing both folder definitions and assignments after refreshing.
Reads reconcile registry projections from the authoritative catalogs. Provenance
and resources remain intact, including during compensation.

The private POST /internal/environment-assets/folders/manage accepts only the two
folder actions under existing internal authorization and the 8 MiB parser limit.
It updates definitions transactionally, rechecks nonempty deletion and collisions,
and returns the same folder success/error shape. The asset service first saves
model assignments and then requests this definition operation. SQL, transactions
and migration 023 belong to the data service; no service imports another's code.

Registration PUT adds optional boolean record.archived. The shared SDK registration
projects it from asset.json. The data service persists it as environment_assets.archived
(migration 023). Listings query active rows only. Legacy registration bodies that
omit archived preserve an existing value on upsert and default false on insert.
Operators can recover a deleted model by clearing archived in its retained catalog
and allowing a subsequent list/read to reconcile the registry. IDs stay reserved;
reimporting archived source files creates a new identity rather than reviving it.

RAR texture resources are decoded in memory by rar_resources.js using the pinned
node-unrar-js dependency. Original archives and source hashes are preserved.
Validated relative names and advertised sizes are checked before extraction;
expanded totals share the 2,000-file/100-MiB import limits. Encrypted, multipart,
malformed, duplicate/traversal and excessive-depth archives are rejected. Nested
RAR contents are retained, not recursively unpacked. No archive codec writes
filesystem paths. Invalid codecs return invalid_archive through the import API.

For existing imports, the service-owned environment:repair-archives <asset-id>
command extracts missing resources and atomically updates runtime.files and history
with an expected-file check. It preserves attribution, names, category, folder
assignments, model files and original checksums, then synchronizes the registry.
It is idempotent; conflicting files or concurrent catalog edits stop the repair.

RAR-only folders now use the same extraction and publication path as RAR texture
resources. prepare_import.js owns bounded envelope decoding, codec expansion and
post-extraction model discovery for both inspection and publication. FBX, OBJ,
GLB/glTF, 3DS and Blender files found inside a RAR become selectable preview models.
The original RAR remains the source descriptor/checksum; unpacked models, textures
and attribution files remain declared resources under source/extracted.

Contract v1: POST /environment-catalog/import/inspect accepts application/zip,
using the import envelope (manifest.json with optional model_category, files/*
with selected relative filenames). It authenticates and checks trusted mutation
origins before parsing the bounded body (128 MiB transport, 100 MiB combined
original/expanded files, 2,000 files). It returns only {models:[relative paths]},
ordered by shared format preference, at most 2,000 paths of at most 500 characters.
Inspection is stateless and repeatable: it writes no files, takes no library lock
and publishes no asset or database row. Invalid archives/paths, missing models
and size/depth limits return the same bounded 400 error codes as import; transport
oversize is 413, unavailable service is 503. Publication independently rechecks
all bytes and selected model; model paths from inspection convey no authority.
No attribution/configuration fields are returned by inspection. UI proxies relay
this contract, and the browser keeps its original files until import is confirmed.
