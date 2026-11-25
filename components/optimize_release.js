import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { component_runtime_json } from "@fracto/sdk/FractoComponentRuntime.js";
import { published_directory } from "./publish.js";
import { optimize_glb } from "./optimize_glb.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function optimize_component_release({
  key,
  release,
  material_ids,
  root = published_directory,
}) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key || "") ||
    !/^[a-f0-9]{64}$/.test(release || "") ||
    !Array.isArray(material_ids) ||
    !material_ids.length ||
    new Set(material_ids).size !== material_ids.length
  )
    throw new Error("invalid_optimization_source");
  const parent = await fs.realpath(path.join(root, key));
  const source = await fs.realpath(path.join(parent, release));
  if (path.dirname(source) !== parent)
    throw new Error("invalid_optimization_source");
  const manifest = JSON.parse(
    await fs.readFile(path.join(source, "manifest.json"), "utf8"),
  );
  if (sha(component_runtime_json(manifest)) !== release)
    throw new Error("optimization_source_corrupt");
  const data = new Map();
  for (const file of manifest.files) {
    const full = await fs.realpath(path.join(source, ...file.path.split("/")));
    if (!full.startsWith(source + path.sep))
      throw new Error("invalid_optimization_source");
    const bytes = await fs.readFile(full);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256)
      throw new Error("optimization_source_corrupt");
    data.set(file.path, bytes);
  }
  const report = [];
  for (const id of material_ids) {
    const descriptor = manifest.materials.find((d) => d.material.id === id);
    if (!descriptor || descriptor.runtime.format !== "glb")
      throw new Error("optimization_material_missing");
    const resource = descriptor.runtime.model,
      old_path = descriptor.file_paths[resource],
      before = data.get(old_path);
    const result = await optimize_glb(before);
    const file = `files/${sha(result.bytes)}.glb`;
    data.set(file, result.bytes);
    descriptor.file_paths[resource] = file;
    report.push({
      material: id,
      source_sha256: sha(before),
      optimized_sha256: sha(result.bytes),
      before_bytes: before.length,
      after_bytes: result.bytes.length,
      compressed_views: result.compressed_views,
    });
  }
  const notice = Buffer.from(
    data.get("NOTICE.txt").toString("utf8") +
      "\nRuntime optimization: lossless EXT_meshopt_compression (meshoptimizer 1.3.0, bitstream v0, filter NONE). Geometry, morph targets, animation samples and texture bytes preserved.\n" +
      report
        .map(
          (r) => `${r.material}: ${r.source_sha256} -> ${r.optimized_sha256}`,
        )
        .join("\n") +
      "\n",
  );
  data.set("NOTICE.txt", notice);
  const used = new Set([
    "NOTICE.txt",
    ...manifest.materials.flatMap((d) => Object.values(d.file_paths)),
  ]);
  const before_bytes = manifest.files.reduce((s, f) => s + f.bytes, 0);
  manifest.files = [...used]
    .sort()
    .map((file) => ({
      path: file,
      sha256: sha(data.get(file)),
      bytes: data.get(file).length,
    }));
  const json = component_runtime_json(manifest),
    next = sha(json),
    target = path.join(parent, next);
  const stage = path.join(parent, `.optimize-${randomUUID()}`);
  await fs.mkdir(stage);
  try {
    for (const file of manifest.files) {
      const full = path.join(stage, ...file.path.split("/"));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, data.get(file.path), { flag: "wx" });
    }
    await fs.writeFile(path.join(stage, "manifest.json"), json + "\n", {
      flag: "wx",
    });
    try {
      await fs.rename(stage, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      if (
        (
          await fs.readFile(path.join(target, "manifest.json"), "utf8")
        ).trim() !== json
      )
        throw error;
      for (const file of manifest.files)
        if (
          sha(await fs.readFile(path.join(target, file.path))) !== file.sha256
        )
          throw new Error("published_release_corrupt");
    }
    return {
      source_release: release,
      release: next,
      before_bytes,
      after_bytes: manifest.files.reduce((s, f) => s + f.bytes, 0),
      materials: report,
    };
  } finally {
    if (
      path.dirname(stage) !== parent ||
      !path.basename(stage).startsWith(".optimize-")
    )
      throw new Error("unsafe_optimization_cleanup");
    await fs.rm(stage, { recursive: true, force: true });
  }
}
