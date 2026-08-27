# fracto-asset-server

Express service for rendering Fracto tile data into JPEG images, embedding metadata, storing local image files, and publishing rendered assets to S3. It listens on port 3003 and depends on the root tile service and shared SDK.

## Repository layout

This is an independent Git repository expected at `fracto/servers/fracto-asset-server/`. It imports `../../constants.js` and modules under `../../sdk/`, so moving it outside that layout breaks shared imports.

Commit service files from this repository. Commit shared SDK, configuration, and supervisor changes from the root repository.

## Requirements

- Node 22, the validated runtime.
- Native build support required by the `canvas` package.
- The Fracto tile server available on port 3004 for rendering.
- AWS CLI installed, authenticated, and available on `PATH` for uploads/imports.
- Permission to read and write the configured S3 bucket.
- ExifTool support supplied by `exiftool-vendored`.

The current implementation contains a fixed S3 bucket, public URL, and ACL policy in source. Review those values before using the service in another environment.

## Installation

From the root repository:

```powershell
npm ci --prefix servers/fracto-asset-server
```

Or from this directory:

```powershell
npm ci
```

The project uses native ES modules. Installing `canvas` may require platform-specific native dependencies.

## Starting the service

Preferred full-system startup from the root repository:

```powershell
npm run start:check
npm start
```

Start only this service through the root launcher:

```powershell
node scripts/launch_service.js fracto-asset-server
```

For isolated development from this directory:

```powershell
npm start
```

The local command uses `nodemon`; the root supervisor runs `index.js` directly. Do not start a second copy while port 3003 is already in use. On startup, `index.js` creates the local `images/` directory when it is missing.

## Rendering lifecycle

A render request performs the following synchronous workflow:

1. Request a canvas buffer from `fracto-tiles-server` on port 3004.
2. Convert that buffer to pixels using the shared `FractoColors` SDK.
3. Encode and save a JPEG under `images/`.
4. Add EXIF/XMP metadata describing the fractal viewport.
5. Invoke the AWS CLI to upload the image to S3 with `public-read` ACL.
6. Return asset metadata and per-stage timing information.

Large images consume significant CPU and memory. The HTTP request remains open while rendering, metadata writing, and upload complete.

## HTTP endpoints

All routes currently use `GET`.

### `GET /`

Basic health endpoint used by the root supervisor. Returns a plain-text welcome message.

### `GET /render_image`

Renders and publishes one image.

Query parameters:

- `width_px`: output width in pixels.
- `aspect_ratio`: height divided by width.
- `focal_point_x`: real coordinate at the image center.
- `focal_point_y`: imaginary coordinate at the image center.
- `scope`: viewport width in fractal coordinates.

The tile request currently uses a fixed `resolution_factor` of `2.0`.

Example:

```text
GET /render_image?width_px=1200&aspect_ratio=1&focal_point_x=-0.75&focal_point_y=0&scope=2.5
```

Response fields include the generated asset ID and JPEG filename, viewport parameters, public S3 URL, and timings for rendering, local writing, EXIF operations, upload, and total duration.

The handler currently returns HTTP 200 even when rendering, metadata, or upload steps log an error. Callers should verify the returned file/URL until error responses are standardized.

### `GET /logs`

The log handler has no active response implementation and should not be used yet.

## Image metadata

Rendered files include EXIF/XMP title, copyright, subject tags, and serialized Fracto viewport metadata. The serialized metadata is written to the `Software` and `XMP:Description` fields and is later consumed by the import utility.

Local files use random names in the form `img_<number>.jpg`. Name collisions are possible because there is no uniqueness check before writing.

## S3 behavior

The renderer currently executes an AWS CLI command equivalent to:

```text
aws s3 cp <local-file> s3://mikehallstudio/fracto/images/ --acl public-read
```

The public URL returned by the API is also hardcoded to the corresponding `us-east-1` location. Bucket name, region, and publication policy are not yet configuration-driven.

Because the command is executed synchronously, a slow or unavailable AWS connection blocks the request. AWS credentials are external to this repository and must not be committed.

## Asset import utility

`handlers/import_assets.js` is an offline maintenance script, not an HTTP handler. It:

1. Reads asset IDs from `handlers/AssetImages.json`.
2. Downloads missing JPEG files from S3 using the AWS CLI.
3. Reads serialized Fracto metadata with ExifTool.
4. Sends asset metadata to the data service on port 3002.

Review its working-directory assumptions, S3 paths, and target data-service behavior before running it. It performs network downloads and database-facing requests and is not exposed through an npm alias.

## Shared root dependencies

Important root-owned dependencies include:

- `constants.js`: asset and tile service ports.
- `sdk/FractoColors.js`: conversion from tile buffers to canvas pixels.
- `config/`: environment-specific AWS/network configuration used elsewhere in the system.
- `logs/`: supervisor-managed service logs.

Changes to these resources belong in the root repository.

## Validation

From the root repository:

```powershell
npm run check
npm run start:check
```

For a health check:

```powershell
node scripts/launch_service.js fracto-asset-server
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3003/
```

Stop the launcher with Ctrl+C afterward.

A complete render test additionally requires a healthy tile server, writable local image storage, ExifTool, and valid AWS access. The service's own `npm test` command is currently a placeholder and intentionally fails.

## Logs and troubleshooting

When supervised by the root process, output is appended to `logs/fracto-asset-server-log-YYYY-MM-DD.txt` in the root repository.

Common failures:

- **Canvas installation fails:** install the native build prerequisites required by the `canvas` package.
- **Empty or failed render:** verify that port 3004 is healthy and inspect the tile-server log.
- **EXIF write fails:** verify the local JPEG exists and `exiftool-vendored` completed installation.
- **S3 upload fails:** verify AWS CLI authentication, bucket access, region, and ACL policy.
- **Port 3003 already in use:** stop the existing supervisor or isolated asset service.
- **Shared import fails:** restore this repository to `fracto/servers/fracto-asset-server/`.
- **Startup update is blocked:** commit, stash, or revert tracked changes in this repository.

The service currently has permissive CORS, no authentication, synchronous external commands, and hardcoded publication settings. Keep it behind a trusted boundary until those areas are hardened.

`tiles.csv` is a local runtime export and should not be committed.