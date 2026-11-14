# Asset route handlers

These modules implement status/log queries, image and video rendering, video
metadata updates and the read-only instrument catalog/audio API.

`instruments.js` serves registered public catalog/audio metadata through the
service's existing enabled-user authorization.

`instrument_transfer.js` mounts the separate internal, private-token-authorized
inventory/transfer API before generic JSON parsing. The instrument owner modules
build source manifests and scan receiver files without writing to the live library.
Step 3 adds reserve/prepare, binary download/upload and staged-byte verification.
Finalize runs full candidate/live validation, durable publication and receipt
creation. Session status can recover receipts from disk after restart; recovery
reconciles committed catalog intent without resuming an incomplete install.
Binary routes retain backpressure, exact lengths, authorization and deadlines.
