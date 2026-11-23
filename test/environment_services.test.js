import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { create_environment_catalog } from "../environment/catalog.js";
import { import_environment_asset } from "../environment/import.js";
import { create_environment_asset_registry } from "../environment/registry_client.js";
import { create_environment_catalog_router } from "../environment/routes.js";
import { CATALOG_FIELDS } from "@fracto/sdk/FractoEnvironmentCatalog.js";

test("Asset storage uses the private data HTTP contract for import/edit/resource behavior", async (t) => {
  const env = { ...process.env };
  process.env.FRACTO_INTERNAL_SERVICE_TOKEN = "boundary-test-token";
  t.after(() => {
    for (const key of [
      "FRACTO_INTERNAL_SERVICE_TOKEN",
      "FRACTO_DATA_PORT",
      "FRACTO_ASSET_PORT",
    ]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  const start = async (app) => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    return server.address().port;
  };
  const directory = await mkdtemp(
    path.join(tmpdir(), "fracto-service-boundary-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("fracto-service-boundary-"));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(directory, "catalog.json"),
    JSON.stringify({ assets: [] }),
  );
  const rows = new Map();
  let unavailable = false;
  const data = express();
  data.use(express.json());
  data.put("/internal/environment-assets/:id", (req, res) => {
    assert.equal(req.get("X-Fracto-Service-Token"), "boundary-test-token");
    if (unavailable)
      return res.status(503).json({ error: "catalog_unavailable" });
    const { record, revision } = req.body;
    rows.set(record.id, { record, revision });
    res.json({ id: record.id, revision });
  });
  data.get("/internal/environment-assets", (req, res) => {
    assert.equal(req.get("X-Fracto-Service-Token"), "boundary-test-token");
    if (unavailable)
      return res.status(503).json({ error: "catalog_unavailable" });
    res.json({
      assets: [...rows.values()]
        .map(({ record }) => ({
          id: record.id,
          name: record.name,
          category: record.model_category,
          model: record.runtime.path,
          format: record.runtime.format,
        }))
        .filter(
          (asset) =>
            !req.query.category || asset.category === req.query.category,
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
      next_cursor: null,
    });
  });
  process.env.FRACTO_DATA_PORT = String(await start(data));
  const store = create_environment_catalog({
    directory,
    registry: create_environment_asset_registry(),
  });
  const asset = express();
  asset.use(
    "/environment-catalog",
    create_environment_catalog_router({
      store,
      authorize: (req, res, next) => next(),
      importer: (body) => import_environment_asset(directory, body),
    }),
  );
  process.env.FRACTO_ASSET_PORT = String(await start(asset));
  const base = `http://127.0.0.1:${process.env.FRACTO_ASSET_PORT}/environment-catalog`;
  const origin =
    process.env.FRACTO_UI_ORIGIN ||
    `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`;
  const triangle = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
  const upload = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        name: "Boundary grass",
        model: "source/files/grass.obj",
      }),
    ),
    "files/grass.obj": strToU8(triangle),
  });
  const imported = await fetch(`${base}/import`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/zip" },
    body: upload,
  });
  assert.equal(imported.status, 200);
  const { id } = await imported.json();
  assert.ok(rows.has(id));
  assert.equal((await (await fetch(base)).json()).assets[0].id, id);
  assert.equal(
    await (await fetch(`${base}/${id}/files/source/files/grass.obj`)).text(),
    triangle,
  );
  assert.equal((await fetch(`${base}/${id}/files/asset.json`)).status, 404);
  const before = await (await fetch(`${base}/${id}`)).json();
  const changes = {
    revision: before.revision,
    attribution: Object.fromEntries(
      CATALOG_FIELDS.map((key) => [key, before.record.attribution[key]]),
    ),
    note: "Adjusted structure.",
  };
  changes.attribution.creator_name = "Asset creator";
  const patch = () =>
    fetch(`${base}/${id}`, {
      method: "PATCH",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
  const saved = await patch();
  assert.equal(saved.status, 200);
  const current = await saved.json();
  assert.equal(rows.get(id).record.attribution.creator_name, "Asset creator");
  assert.equal(rows.get(id).revision, current.revision);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(directory, "ingredients", id, "asset.json"),
        "utf8",
      ),
    ).history.at(-1).description,
    changes.note,
  );
  assert.equal((await patch()).status, 409);
  unavailable = true;
  const failure = await fetch(`${base}/${id}`);
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "catalog_unavailable" });
  unavailable = false;
  assert.equal((await fetch(`${base}/${id}`)).status, 200);
  assert.equal(
    await readFile(
      path.join(directory, "ingredients", id, "source/files/grass.obj"),
      "utf8",
    ),
    triangle,
  );
});

test("database list client follows category pages and rejects non-progressing cursors", async () => {
  const requests = [];
  const row = (id) => ({
    id,
    name: id,
    category: "material",
    model: null,
    format: null,
  });
  const client = create_environment_asset_registry({
    request: async (url) => {
      requests.push(new URL(url));
      return new Response(
        JSON.stringify(
          requests.length === 1
            ? { assets: [row("a")], next_cursor: "a" }
            : { assets: [row("b")], next_cursor: null },
        ),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(
    (await client.list("material")).map((a) => a.id),
    ["a", "b"],
  );
  assert.equal(requests[1].searchParams.get("category"), "material");
  assert.equal(requests[1].searchParams.get("after"), "a");
  const stalled = create_environment_asset_registry({
    request: async () =>
      new Response(JSON.stringify({ assets: [], next_cursor: "a" }), {
        status: 200,
      }),
  });
  await assert.rejects(stalled.list("material"), /catalog_unavailable/);
});

test("folder API delegates to the data contract without touching model files", async (t) => {
  const calls = [];
  const registry = create_environment_asset_registry({
    request: async (url, options) => {
      calls.push({ url, options });
      return Response.json(
        options.method === "POST"
          ? { folder_path: JSON.parse(options.body).folder_path }
          : { folders: ["Empty/Nested"] },
      );
    },
  });
  const store = create_environment_catalog({
    directory: "unused-model-directory",
    registry,
  });
  const app = express();
  app.use(
    "/catalog",
    create_environment_catalog_router({
      store,
      authorize: (req, res, next) => next(),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/catalog/folders`;
  assert.deepEqual(await (await fetch(url + "?category=area")).json(), {
    folders: ["Empty/Nested"],
  });
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: {
        Origin:
          process.env.FRACTO_UI_ORIGIN ||
          `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.deepEqual(
    await (await post({ category: "material", folder_path: "Empty" })).json(),
    { folder_path: "Empty" },
  );
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].url, /internal\/environment-assets\/folders/);
  const count = calls.length;
  assert.equal(
    (await post({ category: "material", folder_path: "../escape" })).status,
    400,
  );
  assert.equal((await post({ category: "material" })).status, 400);
  assert.equal(calls.length, count);
});
