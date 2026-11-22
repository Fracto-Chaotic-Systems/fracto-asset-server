# Ingredients

The simplest reusable 3D forms and pieces used by the app, mostly in games.
The existing grass patches belong here. New local-folder imports are ingredients.

Each ingredient has a permanent asset ID and its own `asset.json`, original
`source/` files, editable `working/` files and derived `runtime/` resources.
Register it in `../catalog.json` as `ingredients/<asset-id>/asset.json`. Preserve
creator/source/license details, modification history and original source hashes.
