import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  mkdir,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  asset_relative_path,
  ASSET_IMPORT_LIMIT,
} from "@fracto/sdk/FractoAssetArchive.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, file) => {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("unsafe_path");
  return file;
};

export function embedded_surface_color(bytes) {
  if (
    bytes.length < 28 ||
    bytes.length > ASSET_IMPORT_LIMIT ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new Error("invalid_glb");
  let json, binary;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error("invalid_glb");
    const length = bytes.readUInt32LE(offset),
      type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > bytes.length || length % 4)
      throw new Error("invalid_glb");
    if (type === 0x4e4f534a) {
      if (json) throw new Error("invalid_glb");
      json = JSON.parse(
        bytes.subarray(offset, offset + length).toString("utf8"),
      );
    }
    if (type === 0x004e4942) {
      if (binary) throw new Error("invalid_glb");
      binary = bytes.subarray(offset, offset + length);
    }
    offset += length;
  }
  const used = new Set(
    (json?.meshes || [])
      .flatMap((mesh) => mesh.primitives.map((item) => item.material))
      .filter(Number.isInteger),
  );
  const images = new Set(
    [...used].map((index) => {
      const material = json.materials?.[index];
      const texture =
        material?.pbrMetallicRoughness?.baseColorTexture ||
        material?.extensions?.KHR_materials_pbrSpecularGlossiness
          ?.diffuseTexture;
      return json.textures?.[texture?.index]?.source;
    }),
  );
  if (images.size !== 1 || !Number.isInteger([...images][0]))
    throw new Error("surface_texture_ambiguous");
  const image = json.images?.[[...images][0]],
    view = json.bufferViews?.[image?.bufferView];
  const offset = view?.byteOffset ?? 0,
    length = view?.byteLength;
  if (
    !binary ||
    image?.uri ||
    view?.buffer !== 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    offset + length > binary.length
  )
    throw new Error("invalid_surface_image");
  const data = Buffer.from(binary.subarray(offset, offset + length));
  const extension =
    image.mimeType === "image/png" &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "png"
      : image.mimeType === "image/jpeg" &&
          data[0] === 255 &&
          data[1] === 216 &&
          data[2] === 255
        ? "jpg"
        : image.mimeType === "image/webp" &&
            data.toString("ascii", 0, 4) === "RIFF" &&
            data.toString("ascii", 8, 12) === "WEBP"
          ? "webp"
          : null;
  if (!extension) throw new Error("invalid_surface_image");
  return { data, extension };
}

/** Explicit service-owned maintenance: preserve source GLB and register its color image. */
export async function extract_environment_surface({ directory, id, registry }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("invalid_asset");
  const library = await realpath(directory);
  const index = JSON.parse(
    await readFile(path.join(library, "catalog.json"), "utf8"),
  );
  const entry = index.assets.find((item) => item.id === id);
  if (!entry) throw new Error("asset_not_found");
  const file = inside(
    library,
    await realpath(path.join(library, asset_relative_path(entry.record))),
  );
  if (path.basename(file) !== "asset.json") throw new Error("unsafe_path");
  const original = await readFile(file),
    record = JSON.parse(original),
    root = path.dirname(file);
  if (
    record.id !== id ||
    record.schema_version !== 1 ||
    record.archived ||
    record.runtime?.format !== "glb"
  )
    throw new Error("invalid_record");
  const resources = record.runtime.files || [record.runtime.path];
  if (!resources.includes(record.runtime.path))
    throw new Error("unregistered_runtime");
  const source = inside(
    root,
    await realpath(path.join(root, asset_relative_path(record.runtime.path))),
  );
  const { data, extension } = embedded_surface_color(await readFile(source));
  const relative = `runtime/surface-base-color-${hash(data).slice(0, 16)}.${extension}`;
  const destination = inside(root, path.resolve(root, relative));
  await mkdir(path.dirname(destination), { recursive: true });
  inside(root, await realpath(path.dirname(destination)));
  try {
    await writeFile(destination, data, { flag: "wx" });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      !data.equals(await readFile(inside(root, await realpath(destination))))
    )
      throw error;
  }
  let published = original;
  if (!resources.includes(relative)) {
    record.runtime.files = [...resources, relative];
    record.history.push({
      date: new Date().toISOString().slice(0, 10),
      action: "extract-surface-color",
      description:
        "Extracted embedded base color for construction floors; source GLB and attribution preserved.",
    });
    published = Buffer.from(JSON.stringify(record, null, 2) + "\n");
    const temporary = path.join(root, `.asset-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, published, { flag: "wx" });
      if (!original.equals(await readFile(file)))
        throw new Error("file_conflict");
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  if (registry) await registry.sync(record, hash(published));
  return { id, texture: relative, sha256: hash(data), bytes: data.length };
}
