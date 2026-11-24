import { createHash } from "node:crypto";
const fail = () => {
  throw new Error("unsupported_rock_glb");
};
const clone = (value) => structuredClone(value);
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a, b) =>
  Array.from({ length: 16 }, (_, i) => {
    const row = i % 4,
      col = Math.floor(i / 4);
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + row] * b[col * 4 + k];
    return v;
  });
function node_matrix(node) {
  if (node.matrix) {
    if (
      node.matrix.length !== 16 ||
      node.matrix.some((v) => !Number.isFinite(v))
    )
      fail();
    return node.matrix;
  }
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * y * y - 2 * z * z) * sx,
    (2 * x * y + 2 * z * w) * sx,
    (2 * x * z - 2 * y * w) * sx,
    0,
    (2 * x * y - 2 * z * w) * sy,
    (1 - 2 * x * x - 2 * z * z) * sy,
    (2 * y * z + 2 * x * w) * sy,
    0,
    (2 * x * z + 2 * y * w) * sz,
    (2 * y * z - 2 * x * w) * sz,
    (1 - 2 * x * x - 2 * y * y) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}
export function read_glb(bytes) {
  if (
    bytes.length < 28 ||
    bytes.length > 128 * 1024 * 1024 ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    fail();
  let json, binary;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset),
      type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) fail();
    if (type === 0x4e4f534a) {
      if (json) fail();
      json = JSON.parse(bytes.subarray(offset, offset + length).toString());
    } else if (type === 0x004e4942) {
      if (binary) fail();
      binary = bytes.subarray(offset, offset + length);
    } else fail();
    offset += length;
  }
  if (
    !json ||
    !binary ||
    json.buffers?.length !== 1 ||
    json.buffers[0].uri ||
    json.buffers[0].byteLength > binary.length
  )
    fail();
  return { json, binary };
}
export function write_glb(json, binary) {
  const raw = Buffer.from(JSON.stringify(json)),
    j = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32),
    b = Buffer.alloc(Math.ceil(binary.length / 4) * 4);
  raw.copy(j);
  binary.copy(b);
  const out = Buffer.alloc(28 + j.length + b.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(j.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  j.copy(out, 20);
  out.writeUInt32LE(b.length, 20 + j.length);
  out.writeUInt32LE(0x004e4942, 24 + j.length);
  b.copy(out, 28 + j.length);
  return out;
}
/** One isolated, normalized, texture-preserving GLB per original static mesh. */
export function split_glb_meshes(bytes) {
  const { json: src, binary } = read_glb(bytes);
  if (
    src.animations?.length ||
    src.skins?.length ||
    src.extensionsUsed?.length ||
    src.extensionsRequired?.length ||
    !src.nodes ||
    !src.meshes ||
    src.meshes.length > 128
  )
    fail();
  const parents = new Map();
  src.nodes.forEach((n, i) =>
    (n.children ?? []).forEach((child) => {
      if (!Number.isInteger(child) || !src.nodes[child] || parents.has(child))
        fail();
      parents.set(child, i);
    }),
  );
  const mesh_nodes = src.nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.mesh !== undefined);
  if (
    mesh_nodes.length !== src.meshes.length ||
    new Set(mesh_nodes.map(({ n }) => n.mesh)).size !== mesh_nodes.length
  )
    fail();
  const view_data = (i) => {
    const v = src.bufferViews?.[i];
    if (
      !v ||
      v.buffer !== 0 ||
      !Number.isSafeInteger(v.byteLength) ||
      v.byteLength <= 0 ||
      !Number.isSafeInteger(v.byteOffset ?? 0) ||
      (v.byteOffset ?? 0) < 0 ||
      (v.byteOffset ?? 0) + v.byteLength > binary.length
    )
      fail();
    return binary.subarray(
      v.byteOffset ?? 0,
      (v.byteOffset ?? 0) + v.byteLength,
    );
  };
  return mesh_nodes.map(({ n, i }, ordinal) => {
    const mesh = src.meshes[n.mesh];
    if (
      !mesh ||
      mesh.primitives.length !== 1 ||
      mesh.primitives[0].targets ||
      mesh.primitives[0].extensions
    )
      fail();
    const primitive = mesh.primitives[0],
      position = src.accessors[primitive.attributes.POSITION];
    if (
      position.componentType !== 5126 ||
      position.type !== "VEC3" ||
      position.sparse ||
      position.count > 1000000
    )
      fail();
    const pv = src.bufferViews[position.bufferView],
      pdata = view_data(position.bufferView),
      stride = pv.byteStride ?? 12;
    const chain = [];
    let at = i;
    while (at !== undefined) {
      if (chain.includes(at) || chain.length > 128) fail();
      chain.unshift(at);
      at = parents.get(at);
    }
    if (!(src.scenes?.[src.scene ?? 0]?.nodes ?? []).includes(chain[0])) fail();
    let world = identity();
    for (const index of chain)
      world = multiply(world, node_matrix(src.nodes[index]));
    const points = [],
      min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < position.count; v++) {
      const off = (position.byteOffset ?? 0) + v * stride;
      if (off + 12 > pdata.length) fail();
      const p = [
          pdata.readFloatLE(off),
          pdata.readFloatLE(off + 4),
          pdata.readFloatLE(off + 8),
        ],
        q = [0, 1, 2].map(
          (a) =>
            world[a] * p[0] +
            world[a + 4] * p[1] +
            world[a + 8] * p[2] +
            world[a + 12],
        );
      if (q.some((v) => !Number.isFinite(v))) fail();
      points.push(q);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], q[a]);
        max[a] = Math.max(max[a], q[a]);
      }
    }
    const span = max.map((v, a) => v - min[a]),
      length = Math.max(span[0], span[2]);
    if (span.some((v) => v <= 0) || !Number.isFinite(length)) fail();
    let diameter2 = 0;
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++)
        diameter2 = Math.max(
          diameter2,
          (points[a][0] - points[b][0]) ** 2 +
            (points[a][2] - points[b][2]) ** 2,
        );
    const center = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2],
      normalize = identity();
    for (const a of [0, 5, 10]) normalize[a] = 1 / length;
    for (let a = 0; a < 3; a++) normalize[12 + a] = -center[a] / length;
    const out = {
        asset: clone(src.asset),
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: "Normalized rock", matrix: normalize, children: [1] }],
        meshes: [],
        accessors: [],
        bufferViews: [],
        buffers: [],
        materials: [],
        textures: [],
        images: [],
        samplers: [],
      },
      chunks = [];
    let offset = 0;
    function add_view(data, extra = {}) {
      const pad = (4 - (offset % 4)) % 4;
      if (pad) {
        chunks.push(Buffer.alloc(pad));
        offset += pad;
      }
      const id = out.bufferViews.length;
      out.bufferViews.push({
        ...extra,
        buffer: 0,
        byteOffset: offset,
        byteLength: data.length,
      });
      chunks.push(Buffer.from(data));
      offset += data.length;
      return id;
    }
    const componentBytes = {
        5120: 1,
        5121: 1,
        5122: 2,
        5123: 2,
        5125: 4,
        5126: 4,
      },
      components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 },
      accessors = new Map();
    function accessor(index) {
      if (accessors.has(index)) return accessors.get(index);
      const a = src.accessors[index],
        v = src.bufferViews?.[a?.bufferView],
        size = componentBytes[a?.componentType] * components[a?.type];
      if (!a || a.sparse || !size || !Number.isInteger(a.count) || a.count < 1)
        fail();
      const data = view_data(a.bufferView),
        start = a.byteOffset ?? 0,
        end = start + (a.count - 1) * (v.byteStride ?? size) + size;
      if (start < 0 || end > data.length) fail();
      const id = out.accessors.length;
      out.accessors.push({
        ...clone(a),
        bufferView: add_view(data.subarray(start, end), {
          ...(v.target ? { target: v.target } : {}),
          ...(v.byteStride ? { byteStride: v.byteStride } : {}),
        }),
        byteOffset: 0,
      });
      accessors.set(index, id);
      return id;
    }
    const textureMap = new Map();
    function texture(index) {
      if (textureMap.has(index)) return textureMap.get(index);
      const t = clone(src.textures[index]),
        image = clone(src.images[t.source]);
      if (!t || t.extensions || !image || image.uri || !image.mimeType) fail();
      image.bufferView = add_view(view_data(image.bufferView));
      t.source = out.images.push(image) - 1;
      if (t.sampler !== undefined)
        t.sampler = out.samplers.push(clone(src.samplers[t.sampler])) - 1;
      const id = out.textures.push(t) - 1;
      textureMap.set(index, id);
      return id;
    }
    const material = clone(src.materials[primitive.material]);
    if (!material) fail();
    function remapTextures(value) {
      for (const [key, item] of Object.entries(value)) {
        if (key.endsWith("Texture") && item && Number.isInteger(item.index))
          item.index = texture(item.index);
        else if (item && typeof item === "object") remapTextures(item);
      }
    }
    remapTextures(material);
    out.materials = [material];
    const p = clone(primitive);
    p.attributes = Object.fromEntries(
      Object.entries(p.attributes).map(([key, id]) => [key, accessor(id)]),
    );
    if (p.indices !== undefined) p.indices = accessor(p.indices);
    p.material = 0;
    out.meshes = [{ ...clone(mesh), primitives: [p] }];
    chain.forEach((index, c) => {
      const node = clone(src.nodes[index]);
      delete node.children;
      if (c < chain.length - 1) node.children = [c + 2];
      if (node.mesh !== undefined) node.mesh = 0;
      out.nodes.push(node);
    });
    out.buffers = [{ byteLength: offset }];
    out.asset.extras = {
      ...out.asset.extras,
      fracto_derivation: {
        source_mesh_index: n.mesh,
        source_node_name: n.name,
        normalization:
          "Longest XZ extent normalized to 1m; centered XZ and minimum Y at zero; original geometry, UVs, normals, materials and image bytes preserved.",
      },
    };
    const glb = write_glb(out, Buffer.concat(chunks));
    return {
      ordinal: ordinal + 1,
      source_mesh_index: n.mesh,
      source_node_name: n.name,
      source_mesh_name: mesh.name,
      dimensions_m: span.map((v) => v / length),
      footprint_m: [span[0] / length, span[2] / length],
      horizontal_diameter_m: Math.sqrt(diameter2) / length,
      horizontal_radius_m:
        Math.max(
          ...points.map((p) => Math.hypot(p[0] - center[0], p[2] - center[2])),
        ) / length,
      geometry_sha256: createHash("sha256")
        .update(JSON.stringify(p.attributes))
        .update(
          Buffer.concat(
            [...accessors.values()].map((a) => {
              const v = out.bufferViews[out.accessors[a].bufferView];
              return Buffer.concat(chunks).subarray(
                v.byteOffset,
                v.byteOffset + v.byteLength,
              );
            }),
          ),
        )
        .digest("hex"),
      bytes: glb,
    };
  });
}
