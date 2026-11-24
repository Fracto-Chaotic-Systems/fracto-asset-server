import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import express from "express";
import { create_component_document } from "@fracto/sdk/FractoComponentDocument.js";
import { empty_material_construction } from "@fracto/sdk/FractoMaterialMetadata.js";
import { publish_component } from "../components/publish.js";
import { create_component_runtime_router } from "../components/routes.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fracto-runtime-"));
  t.after(async () => {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("fracto-runtime-")
    )
      throw Error("unsafe test cleanup");
    await fs.rm(root, { recursive: true, force: true });
  });
  const document = create_component_document(randomUUID(), "Accepted scene");
  document.construction_description = "Authoring only";
  const asset = { id: "tree", revision: "a".repeat(64) };
  document.objects = [
    {
      id: randomUUID(),
      asset,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      group_id: null,
    },
  ];
  const construction = {
    ...empty_material_construction(),
    kind: "model",
    placement: "ground",
    meters_per_unit: 1,
    dimensions_m: [1, 2, 1],
    up_axis: "y",
    forward_axis: "z",
    ground_anchor_m: [0, 0, 0],
    footprint_m: [1, 1],
  };
  const descriptor = {
    material: { ...asset, construction },
    runtime: {
      id: asset.id,
      model: "tree.glb",
      format: "glb",
      resources: ["tree.glb"],
    },
  };
  const options = {
    root,
    key: "test-scene",
    component_url: "http://source/component",
    catalog_url: "http://source/catalog",
    request: async (url) => {
      if (url === "http://source/component")
        return Response.json({ document, revision: 17 });
      if (url.includes("/construction/runtime"))
        return Response.json(descriptor);
      if (url.endsWith("/files/tree.glb"))
        return new Response(Buffer.from("test-model-bytes"));
      if (url.endsWith("/tree"))
        return Response.json({
          revision: asset.revision,
          record: {
            attribution: {
              credit_text: "Test model notice",
              license_name: "CC0",
            },
          },
        });
      throw new Error("unexpected source request " + url);
    },
  };
  return { root, document, options };
}
async function serve(t, root) {
  const app = express();
  app.use("/component-runtime", create_component_runtime_router({ root }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return "http://127.0.0.1:" + server.address().port + "/component-runtime/";
}
test("published component serves unchanged with authoring offline, immutable caching, no private notes or write routes", async (t) => {
  const { root, document, options } = await fixture(t),
    publication = await publish_component(options);
  assert.equal((await publish_component(options)).release, publication.release);
  const base = await serve(t, root),
    url = base + publication.manifest_path;
  options.request = () => {
    throw new Error("authoring is offline");
  };
  document.name = "Rapid new authoring edit";
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /immutable/);
  const manifest = await response.json();
  assert.equal(manifest.component.name, "Accepted scene");
  assert.equal(manifest.component.construction_description, undefined);
  const file = manifest.files.find(
    (f) => f.path === manifest.materials[0].file_paths["tree.glb"],
  );
  const model = await fetch(new URL(file.path, url));
  assert.equal(await model.text(), "test-model-bytes");
  assert.equal(
    (
      await fetch(new URL(file.path, url), {
        headers: { "If-None-Match": model.headers.get("etag") },
      })
    ).status,
    304,
  );
  assert.equal(
    (await fetch(new URL(file.path, url), { method: "HEAD" })).headers.get(
      "content-length",
    ),
    String(file.bytes),
  );
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await fetch(new URL("undeclared.json", url))).status, 404);
  assert.equal((await fetch(new URL("NOTICE.txt", url))).status, 200);
});
test("changed authoring revisions fail publication without leaving a release; corrupt bytes fail closed", async (t) => {
  const { root, options } = await fixture(t),
    request = options.request;
  let reads = 0;
  await assert.rejects(
    publish_component({
      ...options,
      request: async (url) => {
        const response = await request(url);
        if (url.endsWith("/component") && ++reads > 1) {
          const data = await response.json();
          return Response.json({ ...data, revision: 18 });
        }
        return response;
      },
    }),
    /component_changed/,
  );
  assert.deepEqual(await fs.readdir(path.join(root, options.key)), []);
  const published = await publish_component(options),
    manifest = JSON.parse(
      await fs.readFile(path.join(root, published.manifest_path), "utf8"),
    ),
    relative = manifest.materials[0].file_paths["tree.glb"],
    file = path.join(
      root,
      options.key,
      published.release,
      ...relative.split("/"),
    );
  await fs.writeFile(file, "corrupt");
  const base = await serve(t, root);
  assert.equal((await fetch(base + published.manifest_path)).status, 200);
  assert.equal(
    (await fetch(new URL(relative, base + published.manifest_path))).status,
    503,
  );
});
