import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { asset_relative_path } from "@fracto/sdk/FractoAssetArchive.js";
const run = promisify(execFile);
const failure = (code) => Object.assign(new Error(code), { status: 422 });

export async function convert_blend_asset({
  root,
  source,
  execute = run,
  binary = process.env.FRACTO_BLENDER_BIN || "blender",
  runtime_path = "runtime/model.glb",
  report_file = "working/blender-export.json",
}) {
  const runtime = asset_relative_path(runtime_path);
  if (
    !runtime.startsWith("runtime/") ||
    !asset_relative_path(report_file).startsWith("working/")
  )
    throw failure("blender_conversion_failed");
  const output = path.join(root, runtime),
    report_path = path.join(root, report_file);
  const args = [
    "--background",
    "--factory-startup",
    "--disable-autoexec",
    "--threads",
    "2",
    "--python-exit-code",
    "22",
    "--python",
    path.resolve(import.meta.dirname, "../scripts/export_blend_asset.py"),
    "--",
    path.join(root, source),
    output,
    report_path,
    root,
  ];
  try {
    await execute(binary, args, {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2" },
    });
  } catch (error) {
    if (error.code === "ENOENT") throw failure("blender_unavailable");
    const report = await readFile(report_path, "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    if (["blender_missing_textures", "blender_no_mesh"].includes(report.error))
      throw failure(report.error);
    throw failure("blender_conversion_failed");
  }
  const info = await stat(output).catch(() => null);
  if (!info || info.size < 20 || info.size > 100 * 1024 * 1024)
    throw failure("blender_conversion_failed");
  const glb = await readFile(output);
  if (
    glb.readUInt32LE(0) !== 0x46546c67 ||
    glb.readUInt32LE(4) !== 2 ||
    glb.readUInt32LE(8) !== glb.length
  )
    throw failure("blender_conversion_failed");
  const report = JSON.parse(await readFile(report_path, "utf8"));
  return { path: runtime, format: "glb", report_file, report };
}
