import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MeshoptDecoder } from "meshoptimizer/decoder";
import { create_component_document } from "@fracto/sdk/FractoComponentDocument.js";
import { empty_material_construction } from "@fracto/sdk/FractoMaterialMetadata.js";
import { component_runtime_json } from "@fracto/sdk/FractoComponentRuntime.js";
import {
  optimize_glb,
  read_glb,
  write_glb,
} from "../components/optimize_glb.js";
import { optimize_component_release } from "../components/optimize_release.js";
const sha = (b) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const floats = new Float32Array(3000);
  for (let i = 0; i < floats.length; i++) floats[i] = Math.sin(i / 300);
  const raw = Buffer.from(floats.buffer),
    image = Buffer.from("preserve alpha, normal and color texture bytes");
  return write_glb(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: raw.length + image.length }],
      bufferViews: [
        { buffer: 0, byteLength: raw.length, byteStride: 12, target: 34962 },
        { buffer: 0, byteOffset: raw.length, byteLength: image.length },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 1000, type: "VEC3" },
      ],
      images: [{ bufferView: 1, mimeType: "image/png" }],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] },
          ],
          weights: [0],
        },
      ],
      nodes: [{ mesh: 0 }],
      animations: [
        {
          channels: [{ sampler: 0, target: { node: 0, path: "weights" } }],
          samplers: [{ input: 0, output: 0, interpolation: "LINEAR" }],
        },
      ],
    },
    Buffer.concat([raw, image]),
  );
}
test("lossless GLB encoding preserves all geometry, morphs, clips, materials and image bytes", async () => {
  const input = fixture(),
    original = read_glb(input),
    result = await optimize_glb(input),
    optimized = read_glb(result.bytes);
  assert.ok(result.bytes.length < input.length);
  for (const key of [
    "accessors",
    "meshes",
    "nodes",
    "animations",
    "images",
    "materials",
  ])
    assert.deepEqual(optimized.json[key], original.json[key]);
  await MeshoptDecoder.ready;
  for (const [i, view] of optimized.json.bufferViews.entries()) {
    const ext = view.extensions?.EXT_meshopt_compression,
      before = original.json.bufferViews[i];
    const expected = original.binary.subarray(
      before.byteOffset || 0,
      (before.byteOffset || 0) + before.byteLength,
    );
    let actual;
    if (ext) {
      actual = new Uint8Array(view.byteLength);
      MeshoptDecoder.decodeGltfBuffer(
        actual,
        ext.count,
        ext.byteStride,
        optimized.binary.subarray(
          ext.byteOffset,
          ext.byteOffset + ext.byteLength,
        ),
        ext.mode,
        ext.filter,
      );
    } else
      actual = optimized.binary.subarray(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      );
    assert.deepEqual(Buffer.from(actual), expected);
  }
  assert.deepEqual((await optimize_glb(input)).bytes, result.bytes);
  await assert.rejects(
    optimize_glb(result.bytes),
    /unsupported_optimization_layout/,
  );
  await assert.rejects(
    optimize_glb(Buffer.alloc(10)),
    /unsupported_optimization_glb/,
  );
});
test("optimization publishes a new immutable package and retains source component and material pins", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fracto-optimize-"));
  t.after(async () => {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("fracto-optimize-")
    )
      throw Error("unsafe cleanup");
    await fs.rm(root, { recursive: true, force: true });
  });
  const bytes = fixture(),
    model = `files/${sha(bytes)}.glb`,
    notice = Buffer.from("Original attribution\n"),
    id = "grass";
  const material = {
    id,
    revision: "a".repeat(64),
    construction: {
      ...empty_material_construction(),
      kind: "model",
      placement: "ground",
      meters_per_unit: 1,
      dimensions_m: [1, 1, 1],
      footprint_m: [1, 1],
      ground_anchor_m: [0, 0, 0],
      up_axis: "y",
      forward_axis: "z",
    },
  };
  const component = create_component_document(randomUUID(), "Grass");
  component.objects = [
    {
      id: randomUUID(),
      asset: { id, revision: material.revision },
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      group_id: null,
    },
  ];
  const manifest = {
    schema_version: 1,
    source_revision: 1,
    source_document_sha256: "b".repeat(64),
    component,
    materials: [
      {
        material,
        runtime: {
          id,
          model: "grass.glb",
          format: "glb",
          resources: ["grass.glb"],
        },
        file_paths: { "grass.glb": model },
      },
    ],
    files: [
      { path: model, sha256: sha(bytes), bytes: bytes.length },
      { path: "NOTICE.txt", sha256: sha(notice), bytes: notice.length },
    ],
  };
  const json = component_runtime_json(manifest),
    release = sha(json),
    source = path.join(root, id, release);
  await fs.mkdir(path.join(source, "files"), { recursive: true });
  await fs.writeFile(path.join(source, model), bytes);
  await fs.writeFile(path.join(source, "NOTICE.txt"), notice);
  await fs.writeFile(path.join(source, "manifest.json"), json);
  const report = await optimize_component_release({
    key: id,
    release,
    material_ids: [id],
    root,
  });
  assert.notEqual(report.release, release);
  assert.ok(report.after_bytes < report.before_bytes);
  const output = JSON.parse(
    await fs.readFile(path.join(root, id, report.release, "manifest.json")),
  );
  assert.deepEqual(output.component, component);
  assert.deepEqual(output.materials[0].material, material);
  assert.equal(
    await fs.readFile(path.join(source, "manifest.json"), "utf8"),
    json,
  );
  assert.deepEqual(await fs.readFile(path.join(source, model)), bytes);
  assert.equal(
    (
      await optimize_component_release({
        key: id,
        release,
        material_ids: [id],
        root,
      })
    ).release,
    report.release,
  );
  await assert.rejects(
    optimize_component_release({
      key: "../escape",
      release,
      material_ids: [id],
      root,
    }),
    /invalid_optimization_source/,
  );
});
