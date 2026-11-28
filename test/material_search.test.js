import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import {
  CATALOG_FIELDS,
  create_environment_catalog,
} from "../environment/catalog.js";
import { create_environment_catalog_router } from "../environment/routes.js";
import { empty_material_construction } from "@fracto/sdk/FractoMaterialMetadata.js";
import {
  create_material_search,
  MATERIAL_CATALOG_LIMIT,
} from "../environment/material_search.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "fracto-material-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("fracto-material-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const entries = [];
  for (const [id, category, archived] of [
    ["grass", "material", false],
    ["shrub", "material", false],
    ["path", "component", false],
    ["old-grass", "material", true],
  ]) {
    const record = {
      schema_version: 1,
      id,
      name: id,
      version: "1",
      category: "vegetation/" + id,
      model_category: category,
      archived,
      description: "A green border",
      tags: ["foliage"],
      attribution: Object.fromEntries(
        ["status", ...CATALOG_FIELDS].map((key) => [key, null]),
      ),
      sources: [],
      history: [],
      runtime: { path: "model.glb", format: "glb" },
    };
    await mkdir(path.join(directory, id));
    await writeFile(
      path.join(directory, id, "asset.json"),
      JSON.stringify(record),
    );
    await writeFile(
      path.join(directory, id, "model.glb"),
      "untouched model fixture",
    );
    entries.push({ id, record: `${id}/asset.json` });
  }
  await writeFile(
    path.join(directory, "catalog.json"),
    JSON.stringify({ assets: entries }),
  );
  return { directory, store: create_environment_catalog({ directory }) };
}
test("search excludes non-material/archived records; metadata edits persist without changing resources", async (t) => {
  const { directory, store } = await fixture(t);
  const first = await store.search({ limit: "1" });
  assert.equal(first.total, 2);
  assert.equal(first.materials[0].id, "grass");
  const original = await store.get_construction("grass");
  const runtime = await store.get_construction_runtime(
    "grass",
    original.material.revision,
  );
  assert.deepEqual(runtime.runtime, {
    id: "grass",
    model: "model.glb",
    format: "glb",
    resources: ["model.glb"],
    effects: [],
  });
  assert.equal(runtime.material.revision, original.material.revision);
  await assert.rejects(
    store.get_construction_runtime("grass", "f".repeat(64)),
    /material_revision_changed/,
  );
  const changes = {
    revision: original.material.revision,
    description: "Short meadow grass",
    tags: ["meadow", "grass"],
    construction: {
      ...empty_material_construction(),
      kind: "model",
      placement: "ground",
      meters_per_unit: 1,
      dimensions_m: [1, 0.3, 1],
      up_axis: "y",
      forward_axis: "z",
      ground_anchor_m: [0, 0, 0],
      footprint_m: [1, 1],
    },
  };
  await store.update_construction("grass", changes);
  const reopened = create_environment_catalog({ directory });
  assert.equal(
    (await reopened.get_construction("grass")).material.placement_ready,
    true,
  );
  assert.equal(
    (await reopened.search({ q: "meadow", placement: "ground" })).total,
    1,
  );
  await assert.rejects(
    store.update_construction("grass", changes),
    /file_conflict/,
  );
  await assert.rejects(
    store.search({ offset: "1", snapshot: first.snapshot }),
    /material_search_changed/,
  );
  await assert.rejects(store.get_construction("path"), /asset_not_found/);
  assert.equal(
    await readFile(path.join(directory, "grass/model.glb"), "utf8"),
    "untouched model fixture",
  );
  const stored = JSON.parse(
    await readFile(path.join(directory, "grass/asset.json"), "utf8"),
  );
  assert.equal(stored.history.at(-1).action, "update-construction-metadata");
  assert.equal(stored.runtime.path, "model.glb");
});
test("search honors registry membership and bounds/consolidates catalog scans", async () => {
  let scans = 0;
  const search = create_material_search({
    index: async () => {
      scans++;
      return [{ id: "grass" }];
    },
    read: async () => ({
      raw: "record",
      record: { id: "grass", name: "Grass", model_category: "material" },
    }),
    registry: {
      async list() {
        return [];
      },
    },
  });
  const results = await Promise.all([search({ q: "grass" }), search({})]);
  assert.equal(scans, 1);
  assert.equal(results[0].total, 0);
  const large = create_material_search({
    index: async () =>
      Array.from({ length: MATERIAL_CATALOG_LIMIT + 1 }, (_, i) => ({
        id: String(i),
      })),
    read: () => assert.fail("must not scan"),
  });
  await assert.rejects(large({}), /catalog_unavailable/);
});
test("material HTTP APIs enforce authorization/origin and strict query/edit contracts", async (t) => {
  const { store } = await fixture(t);
  const app = express();
  app.use(
    "/catalog",
    create_environment_catalog_router({
      store,
      authorize(req, res, next) {
        if (req.get("X-Test-Token") !== "allowed") return res.sendStatus(403);
        next();
      },
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
  const base = `http://127.0.0.1:${server.address().port}/catalog`;
  const headers = {
    "X-Test-Token": "allowed",
    "Content-Type": "application/json",
    Origin:
      process.env.FRACTO_UI_ORIGIN ||
      `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`,
  };
  assert.equal((await fetch(`${base}/materials/search`)).status, 403);
  assert.equal(
    (await fetch(`${base}/materials/search?limit=999`, { headers })).status,
    400,
  );
  const response = await fetch(`${base}/materials/search?q=grass`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const material = (await response.json()).materials[0];
  const body = {
    revision: material.revision,
    description: "Verified description",
    tags: ["grass"],
    construction: empty_material_construction(),
  };
  const send = (value, origin = headers.Origin) =>
    fetch(`${base}/grass/construction`, {
      method: "PATCH",
      headers: { ...headers, Origin: origin },
      body: JSON.stringify(value),
    });
  assert.equal((await send(body, "http://untrusted.invalid")).status, 403);
  assert.equal((await send({ ...body, account: "excluded" })).status, 400);
  assert.equal((await send(body)).status, 200);
  assert.equal((await send(body)).status, 409);
  const current = await (
    await fetch(`${base}/grass/construction`, { headers })
  ).json();
  assert.equal(
    (
      await fetch(
        `${base}/grass/construction/runtime?revision=${current.material.revision}`,
        { headers },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(
        `${base}/grass/construction/runtime?revision=${material.revision}`,
        { headers },
      )
    ).status,
    409,
  );
});
