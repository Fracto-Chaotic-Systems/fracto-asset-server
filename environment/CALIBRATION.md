# Construction material calibration — 2026-11-23

All four grass, two shrub and four tree catalog records are calibrated and
placement-ready. Facts were persisted through revision-checked construction APIs
and verified against actual Three.js loader geometry, SkeletonUtils cloning and
the stage's unit/orientation/anchor transforms. The new `dry_dirt` is a floor
surface with its original embedded color texture registered as an image resource.
This is authored game calibration, not a real-world survey of the source plants.

| Catalog ID      | Runtime-unit → meter factor | Calibrated X × Y × Z extents (m) |
| --------------- | --------------------------: | -------------------------------- |
| grass-patch-001 |                           1 | 1 × 1 × 1                        |
| animated-grass  |                           1 | 3.4675 × 1.2170 × 3.9125         |
| grasses3        |               0.01 (FBX cm) | 3.8602 × 0.4674 × 4.2696         |
| yard-grass      |              0.05 (curated) | 1.6171 × 0.5173 × 1.4690         |
| shrub1-2        |                           1 | 1.5281 × 1.2649 × 1.6773         |
| shrub2          |              0.05 (curated) | 1.4677 × 1.4127 × 1.4743         |
| tree-2          |          1 (normalized GLB) | 11.1046 × 9.3918 × 11.5146       |
| tree-wind       |               0.1 (curated) | 21.6100 × 7.5567 × 8.6709        |
| trees-animate   |               0.1 (curated) | 21.5126 × 7.5598 × 8.6667        |
| trees-animate-2 |               0.1 (curated) | 37.1262 × 9.9207 × 13.7096       |

All use Y-up and the +Z forward convention. Ground anchors are measured XZ
bounding-box centers at minimum Y, after unit conversion; conservative footprints
are full stage-XZ mesh extents. Animated bounds describe the loader's static
default pose, not a wind/motion envelope. The three large tree demos are tagged
as groups: one group instance is not one tree. `tree-2` is tagged as a single tree.
Its broad crown requires a smaller instance scale for narrow full-footprint
corridors; calibration does not silently shrink geometry to satisfy a build.

Oversized GLB demos use explicit, documented custom game factors, with
`source_units:null`. Standard GLB meters and FBX centimeters are retained where
appropriate. These custom factors are artistic normalization decisions, not
inferred physical-unit evidence. Metadata descriptions disclose them for review.

## Dirt surface and tree runtime repairs

`dry-dirt` (`dry_dirt`) supplies a 2048 × 2048 PNG extracted byte-for-byte from
the GLB's referenced base-color image, not its normal/roughness images. Registered
resource: `runtime/surface-base-color-6f30180943ade5c3.png`; SHA-256
`6f30180943ade5c3ca918e3f1c3b9c47062cabd604c074b9d57c0c73ebcb024c`.
One UV tile is **1 × 1 m**, an explicit game density choice. The source demo plane
has arbitrary scale and does not establish physical scan coverage.

The source `tree-2` FBX produced grossly different transforms in Three.js and
Blender. A separate meter-scale GLB now supplies consistent runtime geometry.
Blender's importer also omitted the leaf diffuse binding. The reviewed per-asset
`working/construction-material-bindings.json` maps `Material.001` to its original
`291722_leave-png.png`. The final `runtime/model-calibrated.glb` embeds the original
bark JPEG and leaf PNG with alpha `MASK`. Earlier runtimes, source FBX, textures,
archives, attribution and source checksum records are preserved. Revision pins
change, so existing stale proposals must be regenerated.

## Reproduction

Asset-owned maintenance commands preserve source files and atomically publish
new catalog resource registrations, then reconcile the data-service registry:

```text
npm run environment:extract-surface -- dry-dirt
npm run environment:normalize-fbx -- tree-2
```

Surface extraction is idempotent. Normalization refuses to overwrite an existing
derived output; do not rerun it blindly against the completed calibration.
`scripts/inspect_construction_models.py` performs read-only Blender geometry/unit
inspection with auto-execution disabled. Actual stage-pose verification is opt-in
from the UI service (Windows PowerShell, normal stack running):

```powershell
$env:FRACTO_TEST_MATERIAL_CALIBRATION='1'
node --test test/live_material_calibration.test.js
```

All eleven asset checks pass, including exact grounded geometry and the dirt
image's registration/dimensions. Texture decoding is omitted from geometry tests;
the dirt image and tree material bindings were inspected separately. Measurements
are written to the UI's ignored `runtime/stage-calibration-measurements.json`.
All 16 original source files across these eleven assets pass their registered
SHA-256 checks after calibration and derived-runtime publication.
See the AI service's construction/EVALUATION.md for live build results; readiness
alone is not evidence of creative scene quality.

# Ladybug runtime calibration

The imported `ladybug-with-animated-walk-cycle-only` under insects is now calibrated
from actual Three.js rest-pose skinned vertices: dimensions
[0.008467181066, 0.004409502087, 0.008892276109] m at curated meters_per_unit=1,
Y-up and +Z forward (head bone measured ahead of body on +Z). Original authoring
units remain unknown. Ground anchor is the footprint center at the lowest foot.
The source GLB and both authored clips are preserved; the first walk clip is used.
The grass strip uses object scale 1.5, about 13.3 mm total length. Grass blade
cross-sections at mid-height measured about 25.4 mm median in the large patches,
so these insects remain small relative to the blades. This is an explicit game
scale choice, not a physical scan claim. Metadata was updated through the
revision-checked construction endpoint; original model files were not rewritten.
