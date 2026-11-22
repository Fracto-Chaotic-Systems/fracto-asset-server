# Grass patch 001

Imported from `D:\mediaplex\models\grasses` on 2026-11-22.
`source/` preserves all four ZIP files and their extracted contents. No license,
creator readme, source URL, or creator name was found. Add these to `asset.json`
when the original download page is available.

The OBJ contains four crossed quads, 16 vertices and four material names, but no
MTL file. `working/build_runtime.py` rebuilds a self-contained GLB using material
1 through 4 with the correspondingly numbered D (base color), N (normal), and R
(roughness) PNGs. Those map roles are inferred from filenames. Normals and
roughness need visual confirmation; no texture channels are inverted. Materials
use double-sided rendering and alpha masking for the grass silhouettes.

Run `python servers/fracto-asset-server/models/grass-patch-001/working/build_runtime.py` from the
repository root to rebuild. No third-party Python packages are needed.

The source units are unspecified. The conversion provisionally treats 100 source
units as one meter, producing a one-meter-tall patch, grounded at y=0 and centered
on x/z. Geometry uses eight triangles. `asset.json` records these assumptions.
The original FBX is also retained for future editing in a modeling tool.
`preview.png` is the first supplied base-color texture, not a rendered model.

Games → assets now provides a rendered GLB preview with independent 1 m
references, a 10 cm grid, scale and lighting controls, texture-map toggles, and
wireframe inspection. The GLB has loaded and rendered successfully there; scale
and material interpretation remain provisional. Preview settings do not edit
this asset. Refresh the public UI copy after rebuilding the canonical GLB.
