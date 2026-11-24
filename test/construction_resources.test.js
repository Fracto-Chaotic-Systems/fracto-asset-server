import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  embedded_surface_color,
  extract_environment_surface,
} from "../environment/extract_surface.js";
import { normalize_environment_fbx } from "../environment/normalize_fbx.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=",
  "base64",
);
function glb() {
  const other = Buffer.from("normal map bytes");
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      meshes: [{ primitives: [{ material: 0 }] }],
      materials: [
        {
          normalTexture: { index: 0 },
          pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
        },
      ],
      textures: [{ source: 0 }, { source: 1 }],
      images: [
        { bufferView: 0, mimeType: "image/png" },
        { bufferView: 1, mimeType: "image/png" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: other.length },
        { buffer: 0, byteOffset: other.length, byteLength: png.length },
      ],
    }),
  );
  const data = Buffer.concat([other, png]);
  const paddedJson = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 32),
  ]);
  const paddedData = Buffer.concat([
    data,
    Buffer.alloc((4 - (data.length % 4)) % 4),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + paddedJson.length + paddedData.length, 8);
  header.writeUInt32LE(paddedJson.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const bin = Buffer.alloc(8);
  bin.writeUInt32LE(paddedData.length, 0);
  bin.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, paddedJson, bin, paddedData]);
}
async function fixture(t, format) {
  const library = await fs.mkdtemp(
    path.join(os.tmpdir(), "fracto-construction-resource-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(library), path.resolve(os.tmpdir()));
    assert.ok(
      path.basename(library).startsWith("fracto-construction-resource-"),
    );
    await fs.rm(library, { recursive: true, force: true });
  });
  const root = path.join(library, "sample");
  await fs.mkdir(path.join(root, "source"), { recursive: true });
  await fs.writeFile(
    path.join(library, "catalog.json"),
    JSON.stringify({ assets: [{ id: "sample", record: "sample/asset.json" }] }),
  );
  const record = {
    schema_version: 1,
    id: "sample",
    attribution: { credit_text: "Preserve credit" },
    sources: [{ path: `source/model.${format}` }],
    construction: { kind: "model", source_units: "cm", meters_per_unit: 0.01 },
    runtime: {
      path: `source/model.${format}`,
      format,
      files: [`source/model.${format}`],
    },
    history: [],
  };
  await fs.writeFile(path.join(root, "asset.json"), JSON.stringify(record));
  await fs.writeFile(
    path.join(root, record.runtime.path),
    format === "glb" ? glb() : Buffer.from("original FBX"),
  );
  return { library, root, record };
}
test("surface extraction chooses base color, preserves source and attribution, and is idempotent", async (t) => {
  const { library, root, record } = await fixture(t, "glb");
  let registered = 0;
  const registry = {
    async sync(saved, revision) {
      registered++;
      assert.equal(saved.id, "sample");
      assert.match(revision, /^[a-f0-9]{64}$/);
    },
  };
  const first = await extract_environment_surface({
    directory: library,
    id: "sample",
    registry,
  });
  assert.deepEqual(await fs.readFile(path.join(root, first.texture)), png);
  assert.deepEqual(
    await fs.readFile(path.join(root, record.runtime.path)),
    glb(),
  );
  const saved = await fs.readFile(path.join(root, "asset.json"));
  assert.deepEqual(JSON.parse(saved).attribution, record.attribution);
  assert.ok(JSON.parse(saved).runtime.files.includes(first.texture));
  await extract_environment_surface({
    directory: library,
    id: "sample",
    registry,
  });
  assert.deepEqual(await fs.readFile(path.join(root, "asset.json")), saved);
  assert.equal(registered, 2);
});
test("surface parser rejects invalid or truncated buffers", () => {
  assert.throws(() => embedded_surface_color(Buffer.alloc(16)), /invalid_glb/);
  assert.throws(
    () => embedded_surface_color(glb().subarray(0, 40)),
    /invalid_glb/,
  );
});
test("FBX normalization publishes a new runtime, preserves source, and invalidates old calibration", async (t) => {
  const { library, root, record } = await fixture(t, "fbx");
  const result = await normalize_environment_fbx({
    directory: library,
    id: "sample",
    convert: async (input) => {
      assert.equal(input.source, record.runtime.path);
      await fs.mkdir(path.join(root, "runtime"));
      await fs.mkdir(path.join(root, "working"));
      await fs.writeFile(path.join(root, "runtime/model.glb"), glb());
      await fs.writeFile(path.join(root, "working/blender-export.json"), "{}");
      return {
        path: "runtime/model.glb",
        format: "glb",
        report_file: "working/blender-export.json",
        report: { warnings: [] },
      };
    },
  });
  const saved = JSON.parse(await fs.readFile(path.join(root, "asset.json")));
  assert.equal(result.runtime, "runtime/model.glb");
  assert.equal(saved.runtime.format, "glb");
  assert.equal(saved.construction.kind, "unknown");
  assert.equal(saved.construction.meters_per_unit, null);
  assert.ok(saved.runtime.files.includes(record.runtime.path));
  assert.deepEqual(saved.attribution, record.attribution);
  assert.equal(
    await fs.readFile(path.join(root, record.runtime.path), "utf8"),
    "original FBX",
  );
});
