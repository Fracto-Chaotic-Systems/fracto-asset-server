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
    (
      await Promise.all(
        index.assets.map(async (asset) => ({
          ...asset,
          archived: JSON.parse(
            await readFile(path.join(expected, asset.record), "utf8"),
          ).archived,
        })),
      )
    )
      .filter((asset) => !asset.archived)
      .map((asset) => asset.id),
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

test("model tree rename and delete preserve identities, attribution, sources and history", async (t) => {
  const { create_model_management } =
    await import("../environment/management.js");
  const { file, record, store } = await fixture(t);
  const manage = create_model_management(store);
  const before = await store.get(record.id);
  await manage({
    action: "rename-model",
    id: record.id,
    revision: before.revision,
    name: "New grass name",
  });
  const renamed = await store.get(record.id);
  assert.equal(renamed.record.name, "New grass name");
  assert.equal(renamed.record.id, record.id);
  assert.deepEqual(renamed.record.attribution, before.record.attribution);
  await assert.rejects(
    manage({
      action: "delete-model",
      id: record.id,
      revision: before.revision,
    }),
    /file_conflict/,
  );
  await manage({
    action: "delete-model",
    id: record.id,
    revision: renamed.revision,
  });
  assert.deepEqual((await store.list("material")).assets, []);
  await assert.rejects(store.get(record.id), /asset_not_found/);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.archived, true);
  assert.deepEqual(saved.sources, record.sources);
  assert.deepEqual(saved.runtime, record.runtime);
  assert.deepEqual(saved.attribution, record.attribution);
  assert.equal(saved.history.at(-1).action, "delete-model");
});

test("folder rename cascades through active model catalogs, preserves other categories and blocks nonempty deletion", async (t) => {
  const { create_model_management } =
    await import("../environment/management.js");
  const rows = new Map(),
    definitions = new Set(["plants", "plants/herbs"]);
  const registry = {
    async sync(record, revision) {
      rows.set(record.id, { ...record, revision });
    },
    async list(category) {
      return [...rows.values()]
        .filter((row) => !row.archived && row.model_category === category)
        .map((row) => ({
          id: row.id,
          name: row.name,
          category: row.model_category,
          folder_path: row.folder_path,
          model: row.runtime.path,
          format: row.runtime.format,
        }));
    },
    async folders(category, path) {
      if (path !== undefined) definitions.add(path);
      return { folders: [...definitions] };
    },
    async manage_folder(body) {
      const { validate_model_management } =
        await import("@fracto/sdk/FractoModelManagement.js");
      const command = validate_model_management(body);
      if (command.action === "rename-folder") {
        for (const path of [...definitions])
          if (
            path === body.folder_path ||
            path.startsWith(body.folder_path + "/")
          ) {
            definitions.delete(path);
            definitions.add(
              command.target + path.slice(body.folder_path.length),
            );
          }
      } else definitions.delete(body.folder_path);
      return { folder_path: body.folder_path };
    },
  };
  const { store, directory, file, record } = await fixture(t, registry);
  record.folder_path = "plants/herbs";
  await writeFile(file, JSON.stringify(record));
  const area = { ...record, id: "test-area", model_category: "area" };
  await mkdir(path.join(directory, area.id));
  await writeFile(
    path.join(directory, area.id, "asset.json"),
    JSON.stringify(area),
  );
  await writeFile(
    path.join(directory, "catalog.json"),
    JSON.stringify({
      assets: [
        { id: record.id, record: record.id + "/asset.json" },
        { id: area.id, record: area.id + "/asset.json" },
      ],
    }),
  );
  const manage = create_model_management(store);
  await assert.rejects(
    manage({
      action: "delete-folder",
      category: "material",
      folder_path: "plants",
    }),
    /folder_not_empty/,
  );
  await manage({
    action: "rename-folder",
    category: "material",
    folder_path: "plants",
    name: "greenery",
  });
  assert.equal(
    (await store.get(record.id)).record.folder_path,
    "greenery/herbs",
  );
  assert.equal((await store.get(area.id)).record.folder_path, "plants/herbs");
  assert.deepEqual([...definitions].sort(), ["greenery", "greenery/herbs"]);
  definitions.add("flowers");
  await assert.rejects(
    manage({
      action: "rename-folder",
      category: "material",
      folder_path: "greenery",
      name: "flowers",
    }),
    /folder_conflict/,
  );
  await manage({
    action: "delete-folder",
    category: "material",
    folder_path: "flowers",
  });
  assert.equal(definitions.has("flowers"), false);
});

test("a failed folder definition rename compensates completed catalog moves", async (t) => {
  const { create_model_management } =
    await import("../environment/management.js");
  const { store, record } = await fixture(t);
  const initial = await store.get(record.id);
  await store.update(record.id, edit(initial, { folder_path: "plants" }));
  store.folders = async () => ({ folders: ["plants"] });
  store.manage_folder = async () => {
    throw Error("folder_conflict");
  };
  const manage = create_model_management(store);
  await assert.rejects(
    manage({
      action: "rename-folder",
      category: "material",
      folder_path: "plants",
      name: "greenery",
    }),
    /folder_conflict/,
  );
  assert.equal((await store.get(record.id)).record.folder_path, "plants");
});

test("tree management HTTP mutations require trusted origin and honor revision conflicts", async (t) => {
  const { store, record } = await fixture(t);
  const catalog = await store.get(record.id);
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
  const url = `http://127.0.0.1:${server.address().port}/catalog/manage`;
  const body = {
    action: "rename-model",
    id: record.id,
    revision: catalog.revision,
    name: "New name",
  };
  const post = (origin, value = body) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(value),
    });
  assert.equal((await post(null)).status, 403);
  const origin =
    process.env.FRACTO_UI_ORIGIN ||
    `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`;
  assert.equal((await post(origin)).status, 200);
  assert.equal((await post(origin)).status, 409);
  assert.equal((await post(origin, { ...body, unexpected: true })).status, 400);
});

test("folder rename compensates a file publication even when its registry synchronization fails", async (t) => {
  const { create_model_management } =
    await import("../environment/management.js");
  let remaining = Infinity;
  const registry = {
    async sync() {
      if (remaining-- <= 0) throw Error("catalog_unavailable");
    },
  };
  const { store, record, file } = await fixture(t, registry);
  const before = await store.get(record.id);
  await store.update(record.id, edit(before, { folder_path: "plants" }));
  store.list = async () => ({
    assets: [{ id: record.id, folder_path: "plants" }],
  });
  store.folders = async () => ({ folders: ["plants"] });
  const get = store.get.bind(store);
  store.get = async (id) => {
    const result = await get(id);
    remaining = 1;
    return result;
  };
  await assert.rejects(
    create_model_management(store)({
      action: "rename-folder",
      category: "material",
      folder_path: "plants",
      name: "greenery",
    }),
    /catalog_unavailable/,
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).folder_path, "plants");
});

test("large concurrent catalog lists share bounded reconciliation and remain complete and fresh", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "fracto-env-list-bound-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("fracto-env-list-bound-"));
    await rm(directory, { recursive: true, force: true });
  });
  const template = JSON.parse(
      await readFile(
        new URL(
          "../models/ingredients/grass-patch-001/asset.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    records = [],
    index = [];
  for (let i = 0; i < 108; i++) {
    const id = "list-test-" + String(i).padStart(3, "0"),
      record = {
        ...structuredClone(template),
        id,
        name: id,
        model_category: ["material", "component", "area"][i % 3],
        archived: i % 25 === 0,
      };
    records.push(record);
    await mkdir(path.join(directory, id));
    await writeFile(
      path.join(directory, id, "asset.json"),
      JSON.stringify(record),
    );
    index.push({ id, record: id + "/asset.json" });
  }
  await writeFile(
    path.join(directory, "catalog.json"),
    JSON.stringify({ assets: index }),
  );
  let active = 0,
    peak = 0,
    syncs = 0,
    unavailable = false;
  const rows = new Map();
  const registry = {
    async sync(record) {
      active++;
      peak = Math.max(peak, active);
      syncs++;
      try {
        if (unavailable || active > 18) throw Error("catalog_unavailable");
        await new Promise((r) => setTimeout(r, 2));
        rows.set(record.id, structuredClone(record));
      } finally {
        active--;
      }
    },
    async list(category) {
      return [...rows.values()]
        .filter((r) => !r.archived && r.model_category === category)
        .map((r) => ({
          id: r.id,
          name: r.name,
          category: r.model_category,
          folder_path: r.folder_path,
          model: r.runtime.path,
          format: r.runtime.format,
        }));
    },
  };
  const store = create_environment_catalog({ directory, registry });
  const categories = ["material", "component", "area"],
    pages = await Promise.all(categories.map((c) => store.list(c)));
  assert.equal(syncs, 108);
  assert.ok(peak <= 4);
  pages.forEach((page, i) => {
    assert.equal(
      page.assets.length,
      records.filter((r) => !r.archived && r.model_category === categories[i])
        .length,
    );
    assert.ok(page.assets.every((a) => a.resources.includes(a.model)));
  });
  records[3].name = "Renamed after first list";
  await writeFile(
    path.join(directory, records[3].id, "asset.json"),
    JSON.stringify(records[3]),
  );
  const fresh = await store.list("material");
  assert.equal(syncs, 216);
  assert.equal(
    fresh.assets.find((a) => a.id === records[3].id).name,
    records[3].name,
  );
  unavailable = true;
  const failures = await Promise.allSettled([
    store.list("material"),
    store.list("area"),
  ]);
  assert.ok(
    failures.every(
      (r) =>
        r.status === "rejected" && r.reason.message === "catalog_unavailable",
    ),
  );
  unavailable = false;
  const recovered = await store.list("material");
  assert.deepEqual(recovered, fresh);
});
