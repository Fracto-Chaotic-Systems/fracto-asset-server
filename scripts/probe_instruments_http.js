// Isolated loopback probe: exercises real registered files without starting
// the video/database service or changing the deployed server's auth settings.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import express from "express";
import { create_instrument_router } from "../handlers/instruments.js";
import { asset_cors } from "../middleware/cors.js";
const { values } = parseArgs({
  options: { "library-dir": { type: "string" }, output: { type: "string" } },
});
const directory = path.resolve(
  values["library-dir"] ??
    fileURLToPath(new URL("../instruments/", import.meta.url)),
);
const token = randomBytes(24).toString("hex");
const headers = {
  "x-fracto-service-token": token,
  origin:
    process.env.FRACTO_UI_ORIGIN ||
    `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`,
};
const app = express();
app.use(asset_cors);
app.use(
  "/instruments",
  (req, res, next) =>
    req.get("x-fracto-service-token") === token ? next() : res.sendStatus(401),
  create_instrument_router({ directory, public_url: "" }),
);
const server = http.createServer(app);
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/instruments`)).status, 401);
  const response = await fetch(`${base}/instruments`, { headers });
  assert.equal(response.status, 200);
  const catalog = await response.json();
  const local = JSON.parse(
    await fs.readFile(path.join(directory, "catalog.json"), "utf8"),
  );
  const paths = new Map(
    local.instruments.flatMap((instrument) =>
      [...instrument.recordings, ...instrument.playback_assets].map((asset) => [
        `${instrument.id}/${asset.id}`,
        asset.path,
      ]),
    ),
  );
  let drum_assets = 0,
    drum_hits = 0;
  let originals = 0,
    playback = 0,
    notes = 0,
    total = 0;
  for (const instrument of catalog.instruments) {
    assert.equal(instrument.available, true);
    assert.equal(
      instrument.enabled,
      local.instruments.find((item) => item.id === instrument.id).enabled,
    );
    for (const [kind, assets] of [
      ["original", instrument.recordings],
      ["playback", instrument.playback_assets],
    ]) {
      for (const asset of assets) {
        assert.equal(asset.available, true);
        const url = new URL(asset.url, base);
        const part = await fetch(url, {
          headers: { ...headers, range: "bytes=0-31" },
        });
        assert.equal(part.status, 206, asset.id);
        assert.equal(
          part.headers.get("content-type"),
          kind === "original" ? asset.mime_type : "audio/wav",
        );
        assert.equal(
          part.headers.get("content-range"),
          `bytes 0-31/${asset.bytes}`,
        );
        assert.equal(part.headers.get("etag"), `"${asset.sha256}"`);
        assert.equal(
          part.headers.get("access-control-allow-credentials"),
          "true",
        );
        const bytes = Buffer.from(await part.arrayBuffer());
        assert.equal(bytes.length, 32);
        const file = await fs.open(
          path.join(directory, paths.get(`${instrument.id}/${asset.id}`)),
          "r",
        );
        try {
          const expected = Buffer.alloc(32);
          await file.read(expected, 0, 32, 0);
          assert.deepEqual(bytes, expected);
        } finally {
          await file.close();
        }
        const head = await fetch(url, { method: "HEAD", headers });
        assert.equal(head.status, 200);
        assert.equal(Number(head.headers.get("content-length")), asset.bytes);
        if (kind === "original") originals++;
        else {
          playback++;
          notes += asset.notes.length;
        }
        total += bytes.length;
      }
    }
  }
  for (const kit of catalog.drum_kits ?? []) {
    assert.equal(
      kit.enabled,
      local.drum_kits.find((item) => item.id === kit.id).enabled,
    );
    assert.equal(
      kit.available,
      kit.enabled && kit.verification_status === "playback_verified",
    );
    assert.deepEqual(
      kit.available_notes,
      kit.available ? kit.notes.map((note) => note.midi_note) : [],
    );
    for (const asset of kit.playback_assets) {
      assert.equal(asset.available, true);
      const url = new URL(asset.url, base);
      const response = await fetch(url, {
        headers: { ...headers, range: "bytes=0-31" },
      });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-type"), "audio/wav");
      assert.equal(response.headers.get("etag"), `"${asset.sha256}"`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const local_kit = local.drum_kits.find((item) => item.id === kit.id);
      const registered = local_kit.playback_assets.find(
        (item) => item.id === asset.id,
      );
      const expected = await fs.readFile(path.join(directory, registered.path));
      assert.deepEqual(bytes, expected.subarray(0, 32));
      const head = await fetch(url, { method: "HEAD", headers });
      assert.equal(head.status, 200);
      assert.equal(Number(head.headers.get("content-length")), asset.bytes);
      drum_assets++;
      drum_hits += asset.hits.length;
      total += bytes.length;
    }
  }
  const revalidated = await fetch(`${base}/instruments`, {
    headers: {
      ...headers,
      "if-none-match": response.headers.get("etag"),
      "cache-control": "max-age=0",
    },
  });
  assert.equal(revalidated.status, 304);
  const report = {
    pass: true,
    library_version: catalog.library_version,
    revision: catalog.revision,
    instruments: catalog.instruments.length,
    audited_drum_kits: catalog.drum_kits?.length ?? 0,
    enabled_drum_kits:
      catalog.drum_kits?.filter((kit) => kit.enabled).length ?? 0,
    prepared_drum_assets: drum_assets,
    prepared_drum_hit_windows: drum_hits,
    original_urls: originals,
    playback_urls: playback,
    playback_notes: notes,
    range_bytes_compared: total,
    head_requests: originals + playback + drum_assets,
    catalog_revalidation_status: 304,
    isolated_loopback_authorization: true,
    browser_playback: "pending",
  };
  if (values.output)
    await fs.writeFile(
      path.resolve(values.output),
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
