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
} from "../environment/catalog.js";
import { create_environment_catalog_router } from "../environment/routes.js";

async function fixture(t, registry = null) {
  const directory = await mkdtemp(path.join(tmpdir(), "fracto-env-catalog-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("fracto-env-catalog-"));
    await rm(directory, { recursive: true, force: true });
  });
  const record = JSON.parse(
    await readFile(
      new URL("../environments/grass-patch-001/asset.json", import.meta.url),
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
