# fire_torch

Original files are preserved in source/files. ZIP/RAR contents are in source/extracted.
Preview model: source/extracted/obj9/fire_torch.obj. Attribution and scale require review.
working/ and runtime/ are reserved for editable sources and future derivatives.

## Preview textures (2026-11-28)

The supplied `Map__0_Mix.tga` is a near-black brown noise, so the extracted
`fire_torch.mtl` now maps generated metal textures instead: bronze body
(`11___Default`), iron cup (`03___Default`) and iron bracket (`02___Default`,
object `Tube02`). The textures are in `working/textures/`; regenerate them with
`python3 working/make_metal_textures.py` (run from `working/`). The unedited
MTL is kept as `working/fire_torch.original.mtl`; the source archives are unchanged.
The pack contains no flame geometry or animation; the flame is an `effects` entry in
`asset.json` (fire anchored in the crown at [0.3, 85, -14.5], 100 units tall and 60 wide;
its light sits 30 up and 35 out from the wall and casts the torch's shadow).
