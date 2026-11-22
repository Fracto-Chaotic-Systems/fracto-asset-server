# Asset service tests

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
