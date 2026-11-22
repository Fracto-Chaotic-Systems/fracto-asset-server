# Environment asset library

MySQL table `environment_assets` tracks each registered asset and its attribution,
model references, original source checksums and modification history. Inventory
metadata reads, imports and edits synchronize it automatically. JSON remains the
portable editable authority; binaries remain here on disk. Apply migration 019,
then run `node servers/fracto-asset-server/scripts/register_environment_assets.js` to register an existing
library. Re-running this command reconciles rows without changing files. Database
failures are reported by Inventory; preserved file saves can be reconciled by the
next metadata read. See `../environment/README.md` for consistency and recovery details.

`catalog.json` indexes assets by permanent ID. Each asset directory contains
`asset.json` (metadata), `source/` (unchanged downloads and extracted files),
`working/` (editable files or reproducible conversion scripts), and `runtime/`
(derived game assets). Paths in a record are relative to its asset directory;
paths in the catalog are relative to this directory.

Search and validate locally from the repository root:

```powershell
python servers/fracto-asset-server/scripts/environment_catalog.py list grass
python servers/fracto-asset-server/scripts/environment_catalog.py validate
```

For a new asset, preserve its original download and accompanying license/readme,
choose a permanent ID, create an asset record, and add it to `catalog.json`.
Record creator name, source URL, license, exact credit text, and any modification
conditions without guessing. Null means unknown. Attribution is retained in the
library and exposed only through the Inventory catalog workflow authorized in
PROJECT_GUIDELINES.md.

Never overwrite originals when editing. Record changes in `history` and create
a new version for a replacement runtime model. Distinct reusable modifications
get their own catalog records with `parent_id` pointing to their source asset;
carry forward attribution and license information. Scene references should pin
an asset ID and version and store placement separately. Source SHA-256 hashes
allow the validator to detect accidental changes to preserved downloads.

The initial grass patch has no supplied creator or license. These are explicitly
unresolved. Its GLB renders in Games → assets, where scale, lighting, texture
maps and topology can be inspected. Source scale and material tuning remain
unconfirmed. The UI serves the registered runtime model and declared resources
directly from this library through its catalog endpoint. Preview adjustments do
not modify these catalog records.

Games → assets displays live attribution and history below the model.
Edit catalog details and Save catalog details write directly to the asset's
registered `asset.json`; no file picker or download is needed. Existing history,
model files and source checksums are retained. Stale revisions are rejected so
external changes are not silently overwritten. The asset service behind the UI's same-origin transport proxy
accepts only asset attribution and modification notes under the task-specific
exception in PROJECT_GUIDELINES.md. Docker Compose binds this directory into the
asset service; native runs use this directory directly. Server deployments can
set FRACTO_ENVIRONMENT_CATALOG_DIR to another canonical library root.

Use Games → assets → Import folder to add assets from local downloads. Select
a preview model and a name, then import. The list updates immediately and is read
from `catalog.json` on later visits. Supported preview formats are GLB/glTF, FBX,
OBJ/MTL and 3DS. ZIP downloads, textures and license/readme files are preserved;
metadata starts unresolved. Identical source sets select the existing asset.
New imports can have no thumbnail yet; the catalog validator accepts that state.

Blender-only folders are supported: the source `.blend` and accompanying textures
remain under `source/files`, while a separate GLB is generated under `runtime`.
The export report and history record any particle preview reduction or material
and texture adaptation. Native servers need Blender on PATH or FRACTO_BLENDER_BIN;
Docker images include it. `grasses-2` is the imported Blender grass example.
