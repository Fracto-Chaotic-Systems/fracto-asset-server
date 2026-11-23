import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import {
  create_environment_catalog,
  CATALOG_FIELDS,
  environment_catalog_directory,
} from "../environment/catalog.js";
import { create_environment_catalog_router } from "../environment/routes.js";

test("the default models library is readable and an external library override is honored", async (t) => {
  const previous = process.env.FRACTO_ENVIRONMENT_CATALOG_DIR;
  t.after(() => {
    if (previous === undefined)
      delete process.env.FRACTO_ENVIRONMENT_CATALOG_DIR;
    else process.env.FRACTO_ENVIRONMENT_CATALOG_DIR = previous;
  });
  delete process.env.FRACTO_ENVIRONMENT_CATALOG_DIR;
  const expected = path.resolve(import.meta.dirname, "../models");
  assert.equal(environment_catalog_directory(), expected);
  const store = create_environment_catalog();
  const { assets } = await store.list();
  const index = JSON.parse(
    await readFile(path.join(expected, "catalog.json"), "utf8"),
  );
  const tiers = ["ingredients", "composites", "environments"];
  const entries = await readdir(expected);
  assert.ok(tiers.every((tier) => entries.includes(tier)));
  assert.ok(
    index.assets.every((asset) => tiers.includes(asset.record.split("/")[0])),
  );
  assert.deepEqual(
    assets.map((asset) => asset.id),
    index.assets.map((asset) => asset.id),
  );
  for (const asset of assets) {
    const resource = await store.file(asset.id, asset.model);
    assert.ok(resource);
  }
  process.env.FRACTO_ENVIRONMENT_CATALOG_DIR = path.join(
    tmpdir(),
    "external-model-library",
  );
  assert.equal(
    environment_catalog_directory(),
    process.env.FRACTO_ENVIRONMENT_CATALOG_DIR,
  );
});

async function fixture(t, registry = null) {
  const directory = await mkdtemp(path.join(tmpdir(), "fracto-env-catalog-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("fracto-env-catalog-"));
    await rm(directory, { recursive: true, force: true });
  });
  const record = JSON.parse(
    await readFile(
      new URL(
        "../models/ingredients/grass-patch-001/asset.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  record.private_extension = { account: "must-not-leave-storage" };
  await mkdir(path.join(directory, record.id));
  const file = path.join(directory, record.id, "asset.json");
  await writeFile(file, JSON.stringify(record));
  await writeFile(
    path.join(directory, "catalog.json"),
    JSON.stringify({
      assets: [{ id: record.id, record: `${record.id}/asset.json` }],
    }),
  );
  const store = create_environment_catalog({
    directory,
    registry,
    now: () => new Date("2026-11-22T12:00:00Z"),
  });
  return { directory, file, record, store };
}
const edit = (view, extra = {}) => ({
  revision: view.revision,
  attribution: Object.fromEntries(
    CATALOG_FIELDS.map((key) => [key, view.record.attribution[key]]),
  ),
  note: "",
  ...extra,
});

test("database registry follows listing and edits with the saved revision", async (t) => {
  const rows = new Map();
  const registry = {
    async list(category) {
      return [...rows.values()]
        .filter(({ record }) => !category || record.model_category === category)
        .map(({ record }) => ({
          id: record.id,
          name: record.name,
          category: record.model_category,
          model: record.runtime.path,
          format: record.runtime.format,
        }));
    },
    async sync(record, revision) {
      rows.set(record.id, { record: structuredClone(record), revision });
    },
  };
  const { store, record } = await fixture(t, registry);
  await store.list();
  assert.ok(rows.has(record.id));
  const before = await store.get(record.id);
  const body = edit(before, { note: "Changed the structure." });
  body.attribution.creator_name = "Asset creator";
  const saved = await store.update(record.id, body);
  assert.equal(rows.get(record.id).revision, saved.revision);
  assert.equal(
    rows.get(record.id).record.attribution.creator_name,
    "Asset creator",
  );
  assert.equal(
    rows.get(record.id).record.history.at(-1).description,
    body.note,
  );
});

test("database outage is reported and a later read repairs a failed post-save synchronization", async (t) => {
  let calls = 0;
  const { store, record, file } = await fixture(t, {
    async sync() {
      if (++calls === 3) throw new Error("database unavailable");
    },
  });
  const before = await store.get(record.id);
  const body = edit(before, { note: "Preserved despite database outage." });
  await assert.rejects(store.update(record.id, body), /database unavailable/);
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).history.at(-1).description,
    body.note,
  );
  const recovered = await store.get(record.id);
  assert.notEqual(recovered.revision, before.revision);
  assert.equal(calls, 4);
});

test("direct catalog saves preserve model/source data, add history, and survive a fresh store", async (t) => {
  const { store, file, record, directory } = await fixture(t);
  const before = await store.get(record.id),
    body = edit(before);
  body.attribution.license_name = "Example license";
  body.note = "Reviewed the catalog editor.";
  const saved = await store.update(record.id, body);
  const disk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(disk.attribution.license_name, "Example license");
  assert.deepEqual(disk.sources, record.sources);
  assert.deepEqual(disk.runtime, record.runtime);
  assert.deepEqual(disk.private_extension, record.private_extension);
  assert.deepEqual(
    disk.history.slice(0, record.history.length),
    record.history,
  );
  assert.equal(disk.history.at(-1).description, body.note);
  assert.equal(disk.history.at(-2).action, "update-attribution");
  assert.notEqual(saved.revision, before.revision);
  assert.deepEqual(
    await create_environment_catalog({ directory }).get(record.id),
    saved,
  );
  assert.deepEqual(await readdir(path.dirname(file)), ["asset.json"]);
  assert.ok(!("private_extension" in saved.record));
  assert.ok(!("original_location" in saved.record));
  assert.deepEqual(Object.keys(saved.record.sources[0]).sort(), [
    "format",
    "path",
  ]);
});

test("concurrent and external edits are rejected without dropping newer data", async (t) => {
  const { store, file, record } = await fixture(t);
  const view = await store.get(record.id);
  const results = await Promise.allSettled([
    store.update(record.id, edit(view, { note: "first" })),
    store.update(record.id, edit(view, { note: "second" })),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    results.find((item) => item.status === "rejected").reason.message,
    "file_conflict",
  );
  const current = await store.get(record.id);
  await writeFile(file, (await readFile(file, "utf8")) + " ");
  await assert.rejects(
    store.update(record.id, edit(current, { note: "stale" })),
    /file_conflict/,
  );
});

test("no-op saves are unchanged; edits cannot replace geometry, source checksums or arbitrary files", async (t) => {
  const { store, directory, record } = await fixture(t);
  const view = await store.get(record.id);
  assert.deepEqual(await store.update(record.id, edit(view)), view);
  await assert.rejects(
    store.update(record.id, { ...edit(view), runtime: {} }),
    /invalid_record/,
  );
  const bad = edit(view);
  bad.attribution.source_url = "javascript:alert(1)";
  await assert.rejects(store.update(record.id, bad), /invalid_url/);
  await assert.rejects(store.get("../escape"), /invalid_asset/);
  await assert.rejects(store.get("unregistered"), /asset_not_found/);
  await writeFile(
    path.join(directory, "catalog.json"),
    JSON.stringify({
      assets: [
        {
          id: record.id,
          record: path.resolve(import.meta.dirname, "../package.json"),
        },
      ],
    }),
  );
  await assert.rejects(store.get(record.id), /catalog_path/);
});

test("HTTP endpoint enforces origin, authentication, bounded bodies and safe error responses", async (t) => {
  const { store, record } = await fixture(t);
  const app = express();
  app.use(
    "/catalog",
    create_environment_catalog_router({
      store,
      authorize: (req, res, next) =>
        req.headers["x-test-denied"]
          ? res.status(401).json({ error: "unauthorized" })
          : next(),
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
  const url = `http://127.0.0.1:${server.address().port}/catalog/${record.id}`;
  const view = await (await fetch(url)).json();
  const headers = {
    "Content-Type": "application/json",
    Origin:
      process.env.FRACTO_UI_ORIGIN ||
      `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`,
  };
  const response = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(edit(view, { note: "http save" })),
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).record.history.at(-1).description,
    "http save",
  );
  assert.equal(
    (
      await fetch(url, {
        method: "PATCH",
        headers: { ...headers, Origin: "https://foreign.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(url, { headers: { "x-test-denied": "1" } })).status,
    401,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ note: "x".repeat(140000) }),
      })
    ).status,
    413,
  );
  const failure = await fetch(url, {
    method: "PATCH",
    headers,
    body: "not-json",
  });
  assert.equal(failure.status, 400);
  assert.deepEqual(await failure.json(), { error: "invalid_record" });
});

test("category lists use database membership and names instead of repeating filesystem materials", async (t) => {
  const { store, record } = await fixture(t, {
    async sync(value) {
      assert.equal(value.model_category, "material");
    },
    async list(category) {
      return category === "component"
        ? [
            {
              id: "database-component",
              name: "Database component",
              category,
              model: null,
              format: null,
            },
          ]
        : category === "area"
          ? []
          : [
              {
                id: "grass-patch-001",
                name: "Database grass name",
                category: "material",
                model: "runtime/grass.glb",
                format: "glb",
              },
            ];
    },
  });
  assert.equal(
    (await store.list("material")).assets[0].name,
    "Database grass name",
  );
  assert.deepEqual(
    (await store.list("component")).assets.map((a) => a.id),
    ["database-component"],
  );
  assert.deepEqual((await store.list("area")).assets, []);
  await assert.rejects(store.list("unknown"), /invalid_record/);
});

test("logical folder edits persist without moving model files or changing attribution", async (t) => {
  let synced;
  const { store, record, file, directory } = await fixture(t, {
    async sync(value) {
      synced = value;
    },
  });
  const before = await store.get(record.id);
  const saved = await store.update(
    record.id,
    edit(before, { folder_path: " Vegetation / Grasses " }),
  );
  assert.equal(saved.record.folder_path, "Vegetation/Grasses");
  assert.equal(synced.folder_path, "Vegetation/Grasses");
  const disk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(disk.folder_path, "Vegetation/Grasses");
  assert.equal(disk.history.at(-1).action, "move-folder");
  assert.deepEqual(disk.attribution, record.attribution);
  assert.deepEqual(disk.runtime, record.runtime);
  assert.deepEqual(disk.sources, record.sources);
  const reopened = create_environment_catalog({ directory });
  assert.equal(
    (await reopened.get(record.id)).record.folder_path,
    "Vegetation/Grasses",
  );
  const legacySave = await store.update(
    record.id,
    edit(saved, { note: "Legacy editor preserves folders." }),
  );
  assert.equal(legacySave.record.folder_path, "Vegetation/Grasses");
  await assert.rejects(
    store.update(record.id, edit(legacySave, { folder_path: "../outside" })),
    /invalid_folder/,
  );
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).folder_path,
    "Vegetation/Grasses",
  );
  const root = await store.update(
    record.id,
    edit(legacySave, { folder_path: "" }),
  );
  assert.equal(root.record.folder_path, "");
});
