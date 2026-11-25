# Asset service tests

`optimize_glb.test.js` verifies byte-exact decoding, retained geometry/morph/clip
metadata and image payloads, deterministic encoding, immutable derived packages,
source preservation, and safe rejection of unsupported input. It uses temporary
packages and changes no authoring library or database records.

`material_search.test.js` uses disposable portable catalogs to test material-only
membership, edits/reopening, unchanged resources, stale revision/snapshot rejection,
bounded coalesced scans and authenticated HTTP search/edit contracts. It does not
write application library records. Root `npm run test:materials` includes SDK and
UI form contracts as well.

`npm run test:environment` covers folder/ZIP/Blender preservation, catalog file
saves, revision conflicts and the asset-to-data HTTP registration contract.
The service suite uses temporary libraries and an HTTP data-service contract double;
no live catalog or database rows are changed.
The default-path regression reads the registered `models/` library and resolves
each preview resource, then verifies the external-directory override. Library
files remain untouched. Import tests check ingredient destinations, nested
catalog entries, cross-tier duplicate detection/global IDs and containment of
symlink/junction publication directories.

Run `npm run test:instruments` for catalog, source/index/audio and HTTP coverage.
`instrument_transfer.test.js` adds isolated inventory/preview coverage: exact file
hashes, missing destinations, catalog/file conflicts, path containment, source
completeness, manifest closure, storage readiness, cancellation and expiry.
It also checks that the transfer-owned percussion README has identical bytes
after Git checkout with Windows-style automatic line endings enabled or disabled.
This checkout regression skips when Git is absent from a minimal runtime image.
`instrument_transfer_fixture.js` supplies disposable stores for both service suites.
`instrument_transfer_stream.test.js` verifies reservations, checksum/length failures,
no-clobber staging, stream cancellation, disk checks, path containment, source
revalidation and verified-cache reuse after restart.
`instrument_publication.test.js` covers full semantic validation, identical/empty
catalog publication, backups, runtime cache invalidation, cancellation at commit,
durable receipts and bootstrap preservation. Its child helper exits at actual
publication boundaries to test process-crash recovery. The explicit
`instrument_persistence_probe.mjs` additionally runs install and verify in separate
disposable Linux containers sharing a labelled volume, as uid 1000; it is not part
of normal test discovery and does not contact production.
No transfer test writes into the application instrument library.

Source-replacement regressions cover differing and invalid-UTF8 catalogs, corrupt
originals/indexes/audio, CRLF support notices, retained file backups, changed live
snapshots, repair of corrupt staging, six real process-crash boundaries across
legacy/replacement modes, restart receipts and zero-payload repeat exports.

Folder endpoint tests exercise the asset HTTP facade and private data client;
invalid paths never reach persistence. Catalog tests cover revision-safe moves.

Tree management regressions cover model rename/archive provenance retention,
recursive category-scoped folder renames, empty-only deletion, HTTP authorization,
stale revisions and compensation after a post-publication registry failure. All
mutations use disposable asset fixtures, never the grass library.

rar_resources.test.js builds tiny stored RAR fixtures and checks real decoding,
traversal/duplicate/encryption/size guards, importer resource publication and
idempotent repair that preserves sources, attribution and preview selection.

RAR tests also cover RAR-only model inspection without publication, model choice
on import, original-archive hashes, extracted license/texture resources, duplicate
imports, and authentication/origin/error behavior before archive decoding.

`construction_resources.test.js` verifies embedded base-color selection rather
than normal-map selection, registered resource publication, idempotence, malformed
GLB rejection and source/attribution preservation. FBX normalization tests verify
new runtime registration and invalidation of stale calibration. Real stage-loader
calibration is an opt-in UI-owned test; see environment/CALIBRATION.md.
