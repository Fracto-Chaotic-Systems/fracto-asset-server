# Asset-service maintenance scripts

`environment_catalog.py list [query]` and `validate` search the service-owned
`models` library across ingredients, composites and environments and check
source hashes/file references. The root catalog supplies the tier-relative paths. Set
`FRACTO_ENVIRONMENT_CATALOG_DIR` for another canonical store.
`register_environment_assets.js` reconciles all registered library records through
the data-service API. Run `npm run environment:register`; this changes no library
files. Set the data port and internal token when running outside the supervisor.

`export_blend_asset.py` runs in Blender with embedded scripts disabled.
`blend_preview_scene.py` evaluates static meshes and bounded particle instances.
The separate GLB/report record conversion warnings; original files are unchanged.
Blender and NumPy are supplied by the combined Docker image or a native install.

`instruments.js` maintains and verifies the instrument library.
`probe_instruments_http.js` checks registered instrument HTTP resources.

repair_environment_archives.js <asset-id> repairs imported RAR resource lists.
Run via npm run environment:repair-archives -- <asset-id>, or inside the running
asset service container. This command owns catalog/filesystem changes; it uses
the private registry endpoint for database synchronization.
