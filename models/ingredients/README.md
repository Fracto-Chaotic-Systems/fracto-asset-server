# Ingredients

The simplest reusable 3D forms and pieces used by the app, mostly in games.
The existing grass patches belong here. New local-folder imports are ingredients.

Each ingredient has a permanent asset ID and its own `asset.json`, original
`source/` files, editable `working/` files and derived `runtime/` resources.
Register it in `../catalog.json` as `ingredients/<asset-id>/asset.json`. Preserve
creator/source/license details, modification history and original source hashes.

Generated ingredients have no `source/` download: the stone doorway set
(`stone-*`, folder `architecture/stone`) is produced by
`../../scripts/generate_stone_materials.py`, and its attribution status is
`original`.
