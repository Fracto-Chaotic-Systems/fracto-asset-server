import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  access,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { asset_relative_path } from "@fracto/sdk/FractoAssetArchive.js";
import { convert_blend_asset } from "./blender_conversion.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, file) => {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("unsafe_path");
  return file;
};
export async function normalize_environment_fbx({
  directory,
  id,
  registry,
  convert = convert_blend_asset,
}) {
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
    record.archived ||
    !["fbx", "glb"].includes(record.runtime?.format) ||
    !record.runtime.files?.includes(record.runtime.path)
  )
    throw new Error("invalid_record");
  const derived = record.runtime.format === "glb";
  const originals = record.runtime.files.filter((file) => /\.fbx$/i.test(file));
  if (
    derived &&
    (!record.history.some((item) => item.action === "normalize-fbx-runtime") ||
      originals.length !== 1)
  )
    throw new Error("invalid_record");
  const source = derived ? originals[0] : record.runtime.path;
  const runtime_path = derived
    ? "runtime/model-calibrated.glb"
    : "runtime/model.glb";
  const report_file = derived
    ? "working/calibrated-export.json"
    : "working/blender-export.json";
  inside(root, await realpath(path.join(root, asset_relative_path(source))));
  // Do not replace an earlier derived runtime or follow a runtime-directory link.
  for (const relative of [runtime_path, report_file])
    if (
      await access(path.join(root, relative)).then(
        () => true,
        () => false,
      )
    )
      throw new Error("file_conflict");
  for (const relative of ["runtime", "working"]) {
    const actual = await realpath(path.join(root, relative)).catch(() => null);
    if (actual) inside(root, actual);
  }
  const result = await convert({ root, source, runtime_path, report_file });
  if (result.path !== runtime_path || result.format !== "glb")
    throw new Error("invalid_conversion");
  record.runtime = {
    ...record.runtime,
    path: result.path,
    format: "glb",
    files: [
      ...new Set([...record.runtime.files, result.path, result.report_file]),
    ],
  };
  // Calibration must be reviewed against the newly normalized runtime.
  if (record.construction)
    record.construction = {
      ...record.construction,
      kind: "unknown",
      meters_per_unit: null,
      source_units: null,
    };
  record.history.push({
    date: new Date().toISOString().slice(0, 10),
    action: "normalize-fbx-runtime",
    description:
      "Generated a meter-scale GLB through Blender for consistent stage transforms; source FBX, textures and attribution preserved.",
  });
  const updated = Buffer.from(JSON.stringify(record, null, 2) + "\n"),
    temporary = path.join(root, `.asset-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, updated, { flag: "wx" });
    if (!original.equals(await readFile(file)))
      throw new Error("file_conflict");
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  if (registry) await registry.sync(record, hash(updated));
  return { id, runtime: result.path, warnings: result.report.warnings };
}
