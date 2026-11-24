# Asset-service maintenance scripts

`publish_component.js` captures an explicitly selected accepted component through
authoring APIs into a validated immutable runtime release. It includes all pinned
model/texture dependencies and notices. See `../components/README.md`; publication
is separate from authoring saves and does not write component/database records.

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

`extract_surface.js <id>` extracts a GLB's unambiguous embedded base-color image
and registers it as a derived construction-floor resource. It preserves the GLB,
attribution and source checksums; repeated extraction preserves the revision.
`normalize_fbx_runtime.js <id>` creates a separate meter-scale GLB through Blender,
retains the FBX/resources and invalidates calibration until reviewed. It refuses
to replace existing derived output. A previously normalized asset may publish
one separate calibrated runtime after reviewed material-binding repairs.
`working/construction-material-bindings.json` optionally maps exact FBX material
names to reviewed source image paths; the converter restores color and PNG alpha
cutouts and records that decision in its report. It never executes model scripts.

`inspect_construction_models.py` measures default-pose mesh bounds, declared FBX
unit conversion and GLB color-image references using Blender with auto-execution
disabled. It writes only an explicit report, never source models or calibration
metadata. Use the actual stage-loader verification to account for importer pose
differences. See environment/CALIBRATION.md for commands and measured evidence.
