# Environment asset ownership

The asset service owns the environment library, folder import, Blender conversion,
catalog edits and registered preview delivery at `/environment-catalog`.
`routes.js` applies authentication, trusted UI mutation origins, bounded parsers
and sanitized errors. `catalog.js` owns revision checks, allowlisted attribution
edits, atomic JSON publication, per-asset edit queues and resource containment.
`import.js` preserves originals/checksums, validates ZIP expansion using the SDK,
serializes imports and publishes staged folders. `blender_conversion.js` runs
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
this location. Existing
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
