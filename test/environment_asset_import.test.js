import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  readdir,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import express from "express";
import { create_environment_catalog_router } from "../environment/routes.js";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { import_environment_asset } from "../environment/import.js";
import { create_environment_catalog } from "../environment/catalog.js";
import {
  asset_relative_path,
  expand_asset_files,
} from "@fracto/sdk/FractoAssetArchive.js";
const triangle = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
const pack = (files, name = "Test prop", model = "source/files/prop.obj") =>
  zipSync({
    "manifest.json": strToU8(JSON.stringify({ name, model })),
    ...Object.fromEntries(
      Object.entries(files).map(([file, data]) => [
        `files/${file}`,
        typeof data === "string" ? strToU8(data) : data,
      ]),
    ),
  });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "fracto-asset-import-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("fracto-asset-import-"));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, "catalog.json"),
    JSON.stringify({ schema_version: 1, assets: [] }),
  );
  return root;
}

test("folder import preserves source bytes and attribution files, registers a live selectable preview", async (t) => {
  const root = await fixture(t);
  const result = await import_environment_asset(
    root,
    pack({
      "prop.obj": triangle,
      "license.txt": "Example terms",
      "textures/diffuse.png": new Uint8Array([1, 2, 3]),
    }),
  );
  assert.deepEqual(result, { id: "test-prop", duplicate: false });
  const index = JSON.parse(
    await readFile(path.join(root, "catalog.json"), "utf8"),
  );
  assert.equal(index.assets[0].record, "ingredients/test-prop/asset.json");
  assert.equal(
    await readFile(
      path.join(root, "ingredients", result.id, "source/files/prop.obj"),
      "utf8",
    ),
    triangle,
  );
  const record = JSON.parse(
    await readFile(
      path.join(root, "ingredients", result.id, "asset.json"),
      "utf8",
    ),
  );
  assert.equal(record.attribution.creator_name, null);
  assert.equal(record.attribution.license_name, null);
  assert.equal(record.attribution.license_file, "source/files/license.txt");
  assert.ok(record.sources.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  const store = create_environment_catalog({ directory: root });
  const { assets } = await store.list();
  assert.equal(assets[0].name, "Test prop");
  assert.equal(assets[0].model, "source/files/prop.obj");
  assert.equal(
    await store.file(result.id, "source/files/prop.obj"),
    path.join(root, "ingredients", result.id, "source/files/prop.obj"),
  );
  await assert.rejects(store.file(result.id, "asset.json"), /asset_not_found/);
  await assert.rejects(
    store.file(result.id, "../../catalog.json"),
    /asset_not_found/,
  );
});

test("duplicate detection and IDs span ingredients, composites and environments", async (t) => {
  const root = await fixture(t);
  const upload = pack({ "prop.obj": triangle });
  const first = await import_environment_asset(root, upload);
  const indexFile = path.join(root, "catalog.json");
  const index = JSON.parse(await readFile(indexFile, "utf8"));
  for (const tier of ["composites", "environments"]) {
    await mkdir(path.join(root, tier));
    const previous = path.dirname(index.assets[0].record);
    await rename(path.join(root, previous), path.join(root, tier, first.id));
    index.assets[0].record = `${tier}/${first.id}/asset.json`;
    await writeFile(indexFile, JSON.stringify(index));
    assert.deepEqual(await import_environment_asset(root, upload), {
      id: first.id,
      duplicate: true,
    });
    const store = create_environment_catalog({ directory: root });
    assert.equal((await store.list()).assets[0].id, first.id);
    assert.equal(
      await readFile(
        await store.file(first.id, "source/files/prop.obj"),
        "utf8",
      ),
      triangle,
    );
  }
  const second = await import_environment_asset(
    root,
    pack({ "prop.obj": triangle + "# second source\n" }),
  );
  assert.equal(second.id, "test-prop-2");
  const updated = JSON.parse(await readFile(indexFile, "utf8"));
  assert.deepEqual(
    updated.assets.map((asset) => asset.record),
    ["environments/test-prop/asset.json", "ingredients/test-prop-2/asset.json"],
  );
});

test("ingredient publication rejects a symlink or junction outside the library", async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  await symlink(
    outside,
    path.join(root, "ingredients"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    import_environment_asset(root, pack({ "prop.obj": triangle })),
    /unsafe_path/,
  );
  assert.deepEqual(await readdir(outside), ["catalog.json"]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8")).assets,
    [],
  );
  assert.ok(
    !(await readdir(root)).some(
      (name) => name.startsWith(".import-") || name === ".catalog-import.lock",
    ),
  );
});

test("ZIP downloads are retained unchanged and expanded resources are available to the selected model", async (t) => {
  const root = await fixture(t),
    archive = zipSync({
      "model/prop.obj": strToU8(triangle),
      "model/prop.mtl": strToU8("newmtl grass"),
    });
  const model = "source/extracted/OBJ/model/prop.obj";
  const result = await import_environment_asset(
    root,
    pack({ "OBJ.zip": archive }, "ZIP prop", model),
  );
  assert.deepEqual(
    new Uint8Array(
      await readFile(
        path.join(root, "ingredients", result.id, "source/files/OBJ.zip"),
      ),
    ),
    archive,
  );
  const { assets } = await create_environment_catalog({
    directory: root,
  }).list();
  assert.ok(
    assets[0].resources.includes("source/extracted/OBJ/model/prop.mtl"),
  );
});

test("duplicate imports select an existing asset and name collisions preserve existing folders", async (t) => {
  const root = await fixture(t),
    upload = pack({ "prop.obj": triangle });
  await mkdir(path.join(root, "ingredients", "test-prop"), { recursive: true });
  await writeFile(path.join(root, "ingredients/test-prop/keep.txt"), "keep");
  const first = await import_environment_asset(root, upload);
  assert.equal(first.id, "test-prop-2");
  assert.deepEqual(await import_environment_asset(root, upload), {
    id: first.id,
    duplicate: true,
  });
  assert.equal(
    await readFile(path.join(root, "ingredients/test-prop/keep.txt"), "utf8"),
    "keep",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8")).assets
      .length,
    1,
  );
  assert.ok(
    !(await readdir(root)).some(
      (name) => name.startsWith(".import-") || name === ".catalog-import.lock",
    ),
  );
});

test("unsafe paths, unsupported folders and invalid model choices leave the library unchanged", async (t) => {
  const root = await fixture(t);
  for (const file of [
    "../escape.obj",
    "C:/escape.obj",
    "/escape.obj",
    "folder/CON.obj",
  ])
    assert.throws(() => asset_relative_path(file), /unsafe_path/);
  assert.throws(
    () =>
      expand_asset_files(
        [{ path: "notes.txt", data: strToU8("notes") }],
        unzipSync,
      ),
    /no_model/,
  );
  assert.throws(
    () =>
      expand_asset_files(
        [
          { path: "PROP.obj", data: strToU8(triangle) },
          { path: "prop.obj", data: strToU8(triangle) },
        ],
        unzipSync,
      ),
    /duplicate_path/,
  );
  await assert.rejects(
    import_environment_asset(
      root,
      pack({ "prop.obj": triangle }, "Bad", "../other.obj"),
    ),
    /invalid_import/,
  );
  assert.deepEqual(await readdir(root), ["catalog.json"]);
});

test("folder upload endpoint registers files and returns a list that survives reopening", async (t) => {
  const root = await fixture(t),
    store = create_environment_catalog({ directory: root });
  const app = express();
  app.use(
    "/catalog",
    create_environment_catalog_router({
      store,
      authorize: (req, res, next) => next(),
      importer: (body) => import_environment_asset(root, body),
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
  const origin =
    process.env.FRACTO_UI_ORIGIN ||
    `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`;
  const result = await fetch(`${base}/import`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/zip" },
    body: pack({ "prop.obj": triangle }),
  });
  assert.equal(result.status, 200);
  const { id } = await result.json();
  const list = await (await fetch(base)).json();
  assert.equal(list.assets[0].id, id);
  const model = await fetch(`${base}/${id}/files/source/files/prop.obj`);
  assert.equal(await model.text(), triangle);
  assert.match(model.headers.get("content-security-policy"), /sandbox/);
  assert.equal((await fetch(`${base}/${id}/files/asset.json`)).status, 404);
  const blocked = await fetch(`${base}/import`, {
    method: "POST",
    headers: {
      Origin: "https://foreign.example",
      "Content-Type": "application/zip",
    },
    body: pack({ "prop.obj": triangle }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(
    (await create_environment_catalog({ directory: root }).list()).assets
      .length,
    1,
  );
});
