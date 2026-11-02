import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import { create_instrument_router } from "../handlers/instruments.js";
import { asset_cors } from "../middleware/cors.js";
import { require_enabled_user_if_configured } from "../../../utils/service_authorization.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quiet = { error: () => {} };

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fracto-http-instruments-"),
  );
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("fracto-http-instruments-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from("ID3 original instrument fixture");
  const content = Buffer.alloc(244);
  content.write("RIFF");
  content.writeUInt32LE(236, 4);
  content.write("WAVEfmt ", 8);
  content.writeUInt32LE(16, 16);
  content.writeUInt16LE(1, 20);
  content.writeUInt16LE(1, 22);
  content.writeUInt32LE(1000, 24);
  content.writeUInt32LE(2000, 28);
  content.writeUInt16LE(2, 32);
  content.writeUInt16LE(16, 34);
  content.write("data", 36);
  content.writeUInt32LE(200, 40);
  for (let i = 1; i < 99; i++) content.writeInt16LE(1000, 44 + i * 2);
  const source_hash = hash(original),
    digest = hash(content);
  const index = {
    schema_version: 1,
    method_version: "test-v1",
    recording_id: "flute-main",
    source_sha256: source_hash,
    sample_rate: 1000,
    channels: 2,
    frames: 410000,
    duration_seconds: 410,
    grid: { slot_seconds: 10, zero_pitch: 20 },
    notes: [
      {
        midi_pitch: 60,
        nominal_seconds: 400,
        offset_seconds: 399.99,
        onset_seconds: 400,
        tail_end_seconds: 400.08,
        end_seconds: 400.09,
        duration_seconds: 0.1,
        pitch_evidence: { matching_windows: 2 },
      },
    ],
    excluded: Array.from({ length: 128 }, (_, midi_pitch) => ({
      midi_pitch,
      reason: "fixture",
    })).filter((n) => n.midi_pitch !== 60),
  };
  const index_bytes = Buffer.from(JSON.stringify(index)),
    index_hash = hash(index_bytes);
  const recording = {
    id: "flute-main",
    filename: "flute.mp3",
    path: "originals/flute.mp3",
    sha256: source_hash,
    bytes: original.length,
    velocity_layer: null,
    mime_type: "audio/mpeg",
    verification_status: "indexing_verified",
    timing: {
      method_version: "test-v1",
      index_path: "indexes/flute-main.json",
      index_sha256: index_hash,
      slot_seconds: 10,
      zero_pitch: 20,
      duration_seconds: 410,
      sample_rate: 1000,
      channels: 2,
      available_pitches: [60],
    },
  };
  const asset = {
    id: "flute-main-chunk-0",
    recording_id: "flute-main",
    path: `playback/flute-main/${digest}.wav`,
    sha256: digest,
    bytes: content.length,
    velocity_layer: null,
    mime_type: "audio/wav",
    encoding: "pcm_s16le",
    sample_rate: 1000,
    channels: 1,
    frames: 100,
    duration_seconds: 0.1,
    decoded_bytes_at_48000: 19200,
    method_version: "mono-octave-pcm16-v1",
    notes: [
      {
        midi_pitch: 60,
        offset_frames: 0,
        frames: 100,
        onset_frame: 10,
        offset_seconds: 0,
        duration_seconds: 0.1,
        tail_guarded: false,
      },
    ],
  };
  const catalog = {
    schema_version: 1,
    library_version: 3,
    playback_preparation: { browser_verification: "pending" },
    instruments: [
      {
        id: "flute",
        name: "Flute",
        kind: "single",
        enabled: false,
        verification_status: "assets_prepared",
        midi_programs: [],
        banks: [],
        pitch_map: {
          type: "recording_indexes",
          indexes: [
            {
              recording_id: "flute-main",
              path: "indexes/flute-main.json",
              sha256: index_hash,
            },
          ],
          available_pitches: [60],
          common_pitches: [60],
        },
        recordings: [recording],
        playback_assets: [asset],
      },
    ],
  };
  for (const folder of ["originals", "indexes", "playback/flute-main"])
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, recording.path), original);
  fs.writeFileSync(path.join(root, asset.path), content);
  fs.writeFileSync(path.join(root, "indexes/flute-main.json"), index_bytes);
  const save = () =>
    fs.writeFileSync(path.join(root, "catalog.json"), JSON.stringify(catalog));
  save();
  return { root, catalog, save, original, content, asset };
}
async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function start(t, f, options = {}) {
  const app = express();
  app.use(asset_cors);
  app.use(
    "/instruments",
    options.authorize ?? ((req, res, next) => next()),
    create_instrument_router({
      directory: f.root,
      public_url: options.public_url ?? "",
      logger: quiet,
    }),
  );
  return listen(t, app);
}
const audio_url = (f, base) =>
  `${base}/instruments/flute/audio/${f.asset.id}?v=${f.asset.sha256}`;

test("catalog provides resolvable versioned URLs and bounded maps without disk paths", async (t) => {
  const f = fixture(t),
    base = await start(t, f);
  const response = await fetch(`${base}/instruments`),
    body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.instruments.length, 1);
  const item = body.instruments[0];
  assert.equal(item.available, true);
  assert.equal(item.enabled, false);
  assert.equal(body.browser_verification, "pending");
  assert.deepEqual(item.available_pitches, [60]);
  assert.equal(
    new URL(item.playback_assets[0].url, base).href,
    audio_url(f, base),
  );
  assert.equal(item.playback_assets[0].notes[0].duration_seconds, 0.1);
  assert.equal(item.recordings[0].available, true);
  const serialized = JSON.stringify(body);
  for (const forbidden of [
    "originals/",
    "indexes/",
    "playback/",
    "source_start_frame",
    f.root,
  ])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  const unchanged = await fetch(`${base}/instruments`, {
    headers: {
      "if-none-match": response.headers.get("etag"),
      "cache-control": "max-age=0",
    },
  });
  assert.equal(unchanged.status, 304);
});

test("WAV/original streaming, HEAD and immutable vs current caching", async (t) => {
  const f = fixture(t),
    base = await start(t, f),
    url = audio_url(f, base);
  const response = await fetch(url);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.content);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), `"${f.asset.sha256}"`);
  assert.match(response.headers.get("cache-control"), /private.*immutable/);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), f.content.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const current = await fetch(url.split("?")[0]);
  assert.equal(current.headers.get("cache-control"), "private, no-cache");
  await current.arrayBuffer();
  const original = await fetch(`${base}/instruments/flute/audio/flute-main`);
  assert.equal(original.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), f.original);
});

test("byte ranges, suffix/open ranges, ETags and If-Range behave consistently", async (t) => {
  const f = fixture(t),
    base = await start(t, f),
    url = audio_url(f, base);
  for (const [range, start, end] of [
    ["bytes=0-43", 0, 43],
    ["bytes=-8", 236, 243],
    ["bytes=44-", 44, 243],
    ["bytes=0-999", 0, 243],
  ]) {
    const response = await fetch(url, { headers: { range } });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes ${start}-${end}/244`,
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      f.content.subarray(start, end + 1),
    );
  }
  const cached = await fetch(url, {
    headers: {
      "if-none-match": `"${f.asset.sha256}"`,
      "cache-control": "max-age=0",
    },
  });
  assert.equal(cached.status, 304);
  const fresh = await fetch(url, {
    headers: { range: "bytes=0-3", "if-range": `"${f.asset.sha256}"` },
  });
  assert.equal(fresh.status, 206);
  await fresh.arrayBuffer();
  const stale = await fetch(url, {
    headers: { range: "bytes=0-3", "if-range": '"stale"' },
  });
  assert.equal(stale.status, 200);
  await stale.arrayBuffer();
});

test("unsupported/unsatisfiable ranges return 416 without audio", async (t) => {
  const f = fixture(t),
    base = await start(t, f);
  for (const range of [
    "bytes=999-",
    "bytes=10-3",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,5-6",
    "nonsense",
  ]) {
    const response = await fetch(audio_url(f, base), { headers: { range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("content-range"), "bytes */244");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test("unknown IDs, encoded paths and stale versions cannot address arbitrary files", async (t) => {
  const f = fixture(t),
    base = await start(t, f);
  for (const route of [
    "/instruments/missing/audio/flute-main",
    "/instruments/flute/audio/catalog-json",
    "/instruments/flute/audio/..%2f..%2fcatalog.json",
    `/instruments/flute/audio/${f.asset.id}?v=${"0".repeat(64)}`,
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404, route);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const malformed = await fetch(`${base}/instruments/flute/audio/%zz`);
  assert.equal(malformed.status, 400);
});

test("missing audio is marked unavailable and changed content invalidates integrity cache", async (t) => {
  const f = fixture(t),
    base = await start(t, f),
    target = path.join(f.root, f.asset.path);
  const initial = await fetch(audio_url(f, base));
  assert.equal(initial.status, 200);
  await initial.arrayBuffer();
  fs.unlinkSync(target);
  const listing = await (await fetch(`${base}/instruments`)).json();
  assert.equal(listing.instruments[0].available, false);
  assert.equal(listing.instruments[0].playback_assets[0].url, null);
  assert.equal((await fetch(audio_url(f, base))).status, 404);
  const corrupt = Buffer.from(f.content);
  corrupt[70] ^= 1;
  fs.writeFileSync(target, corrupt);
  const failed = await fetch(audio_url(f, base));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    error: "Instrument audio is unavailable",
  });
  fs.writeFileSync(target, f.content);
  assert.equal(
    (await fetch(audio_url(f, base), { method: "HEAD" })).status,
    200,
  );
});

test("catalog replacement reloads metadata, invalid catalogs fail closed, public prefixes are explicit", async (t) => {
  const f = fixture(t),
    base = await start(t, f, {
      public_url: "https://assets.example.test/media/",
    });
  const first = await fetch(`${base}/instruments`),
    etag = first.headers.get("etag");
  const first_body = await first.json();
  assert.match(
    first_body.instruments[0].playback_assets[0].url,
    /^https:\/\/assets.example.test\/media\/instruments\//,
  );
  f.catalog.library_version = 4;
  f.save();
  const next = await fetch(`${base}/instruments`, {
    headers: { "if-none-match": etag },
  });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).library_version, 4);
  f.catalog.instruments[0].recordings[0].path = "../outside.mp3";
  f.save();
  const invalid = await fetch(`${base}/instruments`);
  assert.equal(invalid.status, 503);
  assert.deepEqual(await invalid.json(), {
    error: "Instrument catalog is unavailable",
  });
  assert.throws(
    () =>
      create_instrument_router({
        directory: f.root,
        public_url: "file:///tmp",
      }),
    /HTTP/,
  );
});

test("real service authentication protects both reads; CORS permits credentialed UI range fetches", async (t) => {
  const f = fixture(t);
  const saved = Object.fromEntries(
    [
      "FRACTO_AUTH_REQUIRED",
      "FRACTO_INTERNAL_SERVICE_TOKEN",
      "FRACTO_SERVER_PORT",
      "FRACTO_UI_ORIGIN",
      "FRACTO_ALLOW_CORS_ALL",
    ].map((k) => [k, process.env[k]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const auth = await listen(t, (req, res) => {
    const enabled = req.headers.cookie === "sid=enabled",
      disabled = req.headers.cookie === "sid=disabled";
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        authenticated: enabled || disabled,
        auth_state: enabled
          ? "authenticated"
          : disabled
            ? "disabled"
            : "anonymous",
        user: { enabled },
      }),
    );
  });
  Object.assign(process.env, {
    FRACTO_AUTH_REQUIRED: "true",
    FRACTO_INTERNAL_SERVICE_TOKEN: "test-internal-token",
    FRACTO_SERVER_PORT: new URL(auth).port,
    FRACTO_UI_ORIGIN: "http://ui.example.test",
    FRACTO_ALLOW_CORS_ALL: "false",
  });
  const base = await start(t, f, {
    authorize: require_enabled_user_if_configured,
  });
  for (const url of [`${base}/instruments`, audio_url(f, base)]) {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { headers: { cookie: "sid=disabled" } })).status,
      403,
    );
    const allowed = await fetch(url, {
      headers: { cookie: "sid=enabled", origin: "http://ui.example.test" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get("access-control-allow-credentials"),
      "true",
    );
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "http://ui.example.test",
    );
    await allowed.arrayBuffer();
  }
  const preflight = await fetch(audio_url(f, base), {
    method: "OPTIONS",
    headers: {
      origin: "http://ui.example.test",
      "access-control-request-headers": "Range,If-Range",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /Range/);
  assert.match(
    preflight.headers.get("access-control-expose-headers"),
    /Content-Range/,
  );
  const token = await fetch(`${base}/instruments`, {
    headers: { "x-fracto-service-token": "test-internal-token" },
  });
  assert.equal(token.status, 200);
  await token.arrayBuffer();
  // Cached responses still pass through authorization first.
  assert.equal(
    (await fetch(`${base}/instruments`, { headers: { "if-none-match": "*" } }))
      .status,
    401,
  );
});

test("registered originals cannot be served through a substituted directory link", async (t) => {
  const f = fixture(t),
    base = await start(t, f);
  const original = path.join(f.root, "originals"),
    saved = path.join(f.root, "saved-originals");
  assert.ok(path.resolve(original).startsWith(path.resolve(f.root) + path.sep));
  assert.ok(path.resolve(saved).startsWith(path.resolve(f.root) + path.sep));
  fs.renameSync(original, saved);
  try {
    fs.symlinkSync(
      saved,
      original,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Directory links unavailable");
      return;
    }
    throw error;
  }
  const response = await fetch(`${base}/instruments/flute/audio/flute-main`);
  assert.equal(response.status, 404);
  const catalog = await (await fetch(`${base}/instruments`)).json();
  assert.equal(catalog.instruments[0].recordings[0].available, false);
  assert.equal(catalog.instruments[0].recordings[0].url, null);
  assert.equal(catalog.instruments[0].available, true);
});
