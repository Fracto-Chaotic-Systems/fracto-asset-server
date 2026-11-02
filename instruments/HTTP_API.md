# Instrument HTTP API

Current playback status (2026-11-02): **all 21 instruments are enabled** after
75 native Chromium decode/render probes (low/middle/high pitches of every
recording layer) passed through the sample cache and voice engine at 48 kHz.
The catalog marks them playback_verified; detailed evidence is recorded in
browser-verification.json in the asset-server instruments directory. Earlier
disabled/pending statements below describe the initial migration stages.
Native probes confirm signal output, not a subjective listening review.
Reload All Music to fetch the updated catalog. A source can still be disabled
for a track containing notes outside that instrument's verified pitch range.


Implemented 2026-11-02. These read-only routes are mounted in the asset server
(port 3003 by default) after its existing authorization middleware. No upload,
editing or deletion endpoint is introduced. The All Music engine can consume this catalog; the instrument selector consumes its runtime registry and inventory.
Source enablement remains a separate operation.

## GET /instruments

Returns `schema_version`, `library_version`, `revision`, `browser_verification`
and `instruments`. Revision is the SHA-256 of the on-disk catalog; the response
ETag additionally reflects public URLs and current file availability.

Each instrument contains:

- Stable `id`, `name`, `kind`, `enabled` and `verification_status`.
- `available`: all registered playback chunks are present, regular files and
  match their registered byte lengths. This is inventory availability, not a
  browser playback certification. Hashes are checked before audio is served.
- `available_pitches` / `common_pitches`, plus verified `midi_programs` and `banks`
  (currently empty; none are inferred from names).
- `recordings`: original MP3 IDs, velocity-layer labels, MIME type, sizes,
  checksums, timing-grid/coverage summaries, availability flags and URLs.
- `playback_assets`: generated WAV IDs, source-recording/layer identity, method,
  checksums, size/encoding/sample rate, mono channel count, frames/duration,
  decoded size at 48kHz, availability and URLs. `notes` gives pitch, chunk offset,
  duration in frames/seconds, onset in frames, and the tail-guard flag.

The current response has 21 instruments, 25 original URLs and 183 playback URLs
covering 1,999 notes. `enabled` is still false and browser verification is pending;
all prepared sources can be inspected/downloaded by an authorized caller.
A missing original does not prevent otherwise available playback chunks from
being listed. An unavailable asset has `available:false` and `url:null`.

The API projects a whitelist of public metadata: filesystem paths, original Git
paths, index paths and source-frame editing metadata are not returned. Catalog
and index changes are reloaded on demand when catalog file identity/mtime/size
changes. Index hashes, source identity, coverage and bounded index mappings are
validated when a new catalog snapshot loads. Invalid snapshots return 503;
they do not silently fall back to an older catalog.

Caching: `Cache-Control: private, no-cache` and a strong ETag. Matching conditional
requests return 304 when the request permits revalidation. An explicit request
`Cache-Control: no-cache` can force a 200 response through Express freshness rules.

## GET or HEAD /instruments/:id/audio/:asset

Only registered original/processed asset IDs for the selected instrument resolve.
There is no arbitrary filename or filesystem-path parameter. IDs are validated;
unknown IDs, unavailable files, stale versions and storage directory links return
404. Invalid encoded route components return 400. Integrity/catalog failures
return 503 with a generic JSON error and no filesystem paths. Errors use no-store.

Catalog URLs include `?v=<sha256>`. A version parameter must exactly match the
current registration; an obsolete URL cannot return different content under an
old immutable cache key. With a version, caching is
`private, max-age=31536000, immutable`; without it, `private, no-cache`.
Authentication runs before either normal or conditional responses.

Audio is delivered with `audio/mpeg` for originals and `audio/wav` for chunks,
`X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes`, a content SHA-256 ETag
and the appropriate content length. On first use, the service hashes the file
using a bounded stream. The result is cached against file identity, size, mtime
and ctime; changes force revalidation. Metadata requests do not load 1.7GB of
audio into memory. Streaming uses Express sendFile/backpressure.

A single byte range supports bounded, suffix and open-ended forms. Successful
ranges return 206 with Content-Range. Invalid, multiple or unsatisfiable ranges
return 416 with `Content-Range: bytes */<size>`. If-Range and If-None-Match use the
content ETag; a stale If-Range falls back to the complete current representation.
HEAD returns metadata without an audio body.

## Authentication, CORS and configuration

- `FRACTO_AUTH_REQUIRED=true`: requests require an enabled user session, or the
  existing internal service token. Anonymous/disabled callers receive 401/403.
  The token is for trusted services and must not be embedded in browser code.
- CORS retains the configured UI-origin/credential policy. Preflight runs before
  authentication as before. Range and conditional request headers are allowed;
  Accept-Ranges, Content-Range, Content-Length and ETag are exposed to the UI.
- `FRACTO_INSTRUMENT_DIR`: library directory, defaulting to this service's
  `instruments/`, independent of working directory. It must contain the catalog,
  index files and recovered/generated audio storage.
- `FRACTO_ASSET_PUBLIC_URL`: optional public HTTP(S) origin/path prefix, for
  example `https://example.test/assets`. Credentials, query strings, fragments
  and non-HTTP schemes are rejected. The request Host header is never used to
  construct catalog URLs. With no configured prefix, URLs start `/instruments/`.

Preserve the configured asset-server proxy prefix when resolving root-relative
URLs. Absolute URLs from FRACTO_ASSET_PUBLIC_URL are used directly:

```js
const response = await fetch(`${assetServer}/instruments`, {
  credentials: 'include',
});
if (!response.ok) throw new Error('Instrument catalog unavailable');
const catalog = await response.json();
const flute = catalog.instruments.find(instrument => instrument.id === 'flute');
const asset = flute.playback_assets.find(asset =>
  asset.available && asset.notes.some(note => note.midi_pitch === 60));
const audioURL = asset.url.startsWith('/instruments/')
  ? new URL(`${assetServer.replace(/\/$/, '')}${asset.url}`, response.url).href
  : new URL(asset.url, response.url).href;
const audioResponse = await fetch(audioURL, { credentials: 'include' });
if (!audioResponse.ok) throw new Error('Instrument audio unavailable');
const bytes = await audioResponse.arrayBuffer();
```

This is a retrieval example. The integrated engine selects registered layers,
verifies SHA-256/encoded lengths, bounds each voice to its pitch window and
enforces decoded memory limits. Inventory availability does not enable a source.
See [MIGRATION_VERIFICATION.md](MIGRATION_VERIFICATION.md) for verification scope.

## Validation

```powershell
npm run test:instruments
npm run instruments:probe-http -- --output instruments/http-verification.json
```

22 instrument tests pass, including 9 loopback HTTP cases. They cover catalog
projection, URLs, streaming/HEAD, ranges and conditionals, version mismatch,
missing/tampered files, catalog reload/invalid metadata, directory links,
real enabled-user/service-token authentication and credentialed CORS.
The shared root service-authorization suite also passes all 5 tests.

The isolated real-library probe bound only to loopback on an ephemeral port,
required a random per-run token and closed its server afterward. It did not
start or change the running video/database service. Every one of the 208 URLs
returned the correct 32-byte range and HEAD length; 6,656 bytes were compared
against disk, and the catalog revalidated with 304. Each first stream additionally
verified the complete file hash against the catalog. See http-verification.json.
Browser playback is not asserted by this HTTP verification.
