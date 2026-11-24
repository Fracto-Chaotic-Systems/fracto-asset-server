import assert from "node:assert/strict";
import test from "node:test";
import {
  read_glb,
  write_glb,
  split_glb_meshes,
} from "../environment/split_glb_meshes.js";
function fixture() {
  const positions = Buffer.alloc(48);
  [0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) =>
    positions.writeFloatLE(v, i * 4),
  );
  const textureA = Buffer.from([1, 2, 3, 4]),
    textureB = Buffer.from([5, 6, 7, 8]);
  const j = {
    asset: { version: "2.0", extras: { author: "Original creator" } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { children: [1, 2] },
      { mesh: 0, translation: [40, 0, 30] },
      { mesh: 1, translation: [-40, 0, 30], scale: [2, 1, 1] },
    ],
    meshes: [0, 1].map((i) => ({
      name: "Rock " + i,
      primitives: [{ attributes: { POSITION: 0 }, material: 0, mode: 4 }],
    })),
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3" }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 4 },
      { buffer: 0, byteOffset: 52, byteLength: 4 },
    ],
    buffers: [{ byteLength: 56 }],
    materials: [
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        normalTexture: { index: 1 },
      },
    ],
    textures: [{ source: 0 }, { source: 1 }],
    images: [
      { bufferView: 1, mimeType: "image/jpeg" },
      { bufferView: 2, mimeType: "image/jpeg" },
    ],
  };
  return write_glb(j, Buffer.concat([positions, textureA, textureB]));
}
test("split meshes once, preserve material and image bytes, remove the array grid through normalization", () => {
  const bytes = fixture(),
    before = Buffer.from(bytes),
    parts = split_glb_meshes(bytes);
  assert.equal(parts.length, 2);
  assert.deepEqual(
    parts.map((p) => p.source_mesh_index),
    [0, 1],
  );
  assert.deepEqual(parts[0].dimensions_m, [1, 0.5, 0.5]);
  assert.deepEqual(parts[1].dimensions_m, [1, 0.25, 0.25]);
  for (const p of parts) {
    const { json, binary } = read_glb(p.bytes);
    assert.equal(json.meshes.length, 1);
    assert.equal(json.asset.extras.author, "Original creator");
    assert.equal(json.textures.length, 2);
    assert.equal(
      json.materials[0].pbrMetallicRoughness.baseColorTexture.index,
      0,
    );
    assert.equal(json.materials[0].normalTexture.index, 1);
    json.images.forEach((img, i) => {
      const v = json.bufferViews[img.bufferView];
      assert.deepEqual(
        [...binary.subarray(v.byteOffset, v.byteOffset + v.byteLength)],
        i ? [5, 6, 7, 8] : [1, 2, 3, 4],
      );
    });
    assert.ok(p.horizontal_diameter_m >= 1);
    assert.ok(p.bytes.length < 4096);
  }
  assert.deepEqual(bytes, before);
});
test("reject malformed, animated, compressed or repeated-mesh collections before publication", () => {
  assert.throws(() => split_glb_meshes(Buffer.from("invalid")));
  for (const edit of [
    (j) => (j.animations = [{}]),
    (j) => (j.extensionsUsed = ["KHR_draco_mesh_compression"]),
    (j) => (j.nodes[2].mesh = 0),
    (j) => (j.accessors[0].sparse = {}),
  ]) {
    const { json, binary } = read_glb(fixture());
    edit(json);
    assert.throws(() => split_glb_meshes(write_glb(json, binary)));
  }
});
