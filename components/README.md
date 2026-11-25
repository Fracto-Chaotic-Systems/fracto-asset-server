# Published component ownership

`publish.js` captures accepted component documents and pinned material resources
through explicit authoring HTTP APIs. It validates calibration, copies every
runtime dependency and attribution notice, rechecks the source revision, and
atomically publishes an immutable directory named by the canonical manifest hash.
Failed publication removes only its staging directory; existing releases remain.
No component records, material catalogs or source binaries are modified.

`optimize_glb.js` applies lossless `EXT_meshopt_compression`, bitstream v0 and
filter NONE, verifying every decoded buffer against its original bytes. It never
quantizes vertices, simplifies geometry, changes animation samples or converts
textures. `optimize_release.js` verifies a complete existing package and publishes
a new hash with selected GLBs replaced and attribution retained. Component data,
source revision and calibrated material pins stay identical; old releases remain.
Run `node scripts/optimize_component.js --key grass-strip --release SHA256
--materials animated-grass,yard-grass`. Only single-buffer, self-contained GLBs
without preexisting extensions are accepted by this deliberately narrow tool.
The browser must enable its bundled Three.js Meshopt decoder before selecting
the new release. [Encoding contract](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Vendor/EXT_meshopt_compression).

`serve_runtime.js` can serve the same releases as a standalone file-only process
without the combined server's authoring/startup dependencies. Run
`FRACTO_RUNTIME_PORT=3008 node components/serve_runtime.js` (set the environment
variable using the host shell's syntax). It binds loopback by default; a deployment
may explicitly set `FRACTO_RUNTIME_HOST`. Static hosting/CDN delivery of the same
release directory is also supported by the browser package loader.

`routes.js` serves only declared files from `published/` at
`GET/HEAD /component-runtime/:key/:sha256/manifest.json` and the same release's
declared resource paths. Manifests are validated on first use; requested files
are verified once with shared in-flight verification. Unused dependencies are
not read before returning the manifest. Releases are cached and served
with immutable one-year caching and content-derived ETags. Undeclared paths,
traversal and writes are rejected. A missing release returns 404; corruption is 503. This is deliberately published game content, separate from authenticated
authoring routes. No authoring registry, database or inference code is imported.

Run `node scripts/publish_component.js --key grass-strip --component-url
http://localhost:3102/component-documents/ID --catalog-url
http://localhost:3103/environment-catalog` while authoring services are available.
Then deploy the release directory with the asset service and explicitly select its
manifest in the consuming game's release binding. Publishing creates a new hash;
editing an authoring document never changes an existing game release. The authoring
description remains in the data service and is excluded from runtime manifests.
