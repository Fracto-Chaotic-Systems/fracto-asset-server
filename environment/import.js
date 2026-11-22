import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  rename,
  rm,
  open,
  unlink,
  access,
} from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { convert_blend_asset } from "./blender_conversion.js";
import {
  asset_relative_path,
  asset_format,
  bounded_unzip,
  expand_asset_files,
} from "@fracto/sdk/FractoAssetArchive.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (files) =>
  hash(
    JSON.stringify(
      files
        .map((file) => [
          file.path.replace(/^source\/(?:files\/)?/, ""),
          file.sha256,
        ])
        .sort((a, b) => a[0].localeCompare(b[0])),
    ),
  );
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};

export async function import_environment_asset(
  directory,
  upload,
  { convert_blend = convert_blend_asset } = {},
) {
  const envelope = bounded_unzip(upload, unzipSync);
  if (!envelope["manifest.json"] || envelope["manifest.json"].length > 4096)
    fail("invalid_import");
  const manifest = JSON.parse(
    new TextDecoder().decode(envelope["manifest.json"]),
  );
  if (
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    manifest.name.length > 120 ||
    typeof manifest.model !== "string"
  )
    fail("invalid_import");
  const originals = Object.entries(envelope)
    .filter(([name]) => name.startsWith("files/"))
    .map(([name, data]) => ({ path: name.slice(6), data }));
  const { entries, models } = expand_asset_files(originals, unzipSync);
  if (!models.includes(manifest.model)) fail("invalid_import");
  const sources = entries
    .filter((file) => file.original)
    .map((file) => ({
      path: file.path,
      format: asset_format(file.path),
      sha256: hash(file.data),
      bytes: file.data.length,
    }));
  const signature = fingerprint(sources),
    root = await realpath(directory);
  const lock_path = path.join(root, ".catalog-import.lock");
  let lock;
  try {
    lock = await open(lock_path, "wx");
  } catch (error) {
    if (error.code === "EEXIST") fail("import_busy", 409);
    throw error;
  }
  const stage = path.join(root, `.import-${randomUUID()}`);
  let destination,
    published = false;
  try {
    const index_path = path.join(root, "catalog.json"),
      raw_index = await readFile(index_path, "utf8");
    const catalog = JSON.parse(raw_index);
    for (const entry of catalog.assets) {
      const relative = asset_relative_path(entry.record);
      const file = await realpath(path.join(root, relative));
      if (path.relative(root, file).startsWith("..")) fail("unsafe_path");
      const record = JSON.parse(await readFile(file, "utf8"));
      if (
        (record.import_fingerprint || fingerprint(record.sources)) === signature
      )
        return { id: entry.id, duplicate: true };
    }
    const slug =
      manifest.name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "asset";
    const base = /^[a-z]/.test(slug) ? slug : `asset-${slug}`;
    let id = base,
      suffix = 2;
    const exists = async (name) => {
      try {
        await access(path.join(root, name));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    };
    while (
      catalog.assets.some((entry) => entry.id === id) ||
      (await exists(id))
    )
      id = `${base}-${suffix++}`;
    destination = path.join(root, id);
    await mkdir(stage);
    for (const entry of entries) {
      const file = path.join(stage, asset_relative_path(entry.path));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, entry.data, { flag: "wx" });
    }
    await mkdir(path.join(stage, "working"));
    await mkdir(path.join(stage, "runtime"));
    const converted =
      asset_format(manifest.model) === "blend"
        ? await convert_blend({ root: stage, source: manifest.model })
        : null;
    const preview_model = converted?.path || manifest.model;
    const day = new Date().toISOString().slice(0, 10);
    const record = {
      schema_version: 1,
      id,
      version: "1.0.0",
      name: manifest.name.trim(),
      description: "Imported environment asset.",
      category: "environment",
      tags: [],
      parent_id: null,
      imported_on: day,
      import_fingerprint: signature,
      attribution: {
        status: "unresolved",
        creator_name: null,
        creator_profile_url: null,
        source_url: null,
        license_name: null,
        license_file:
          entries.find((entry) =>
            /(?:^|\/)(?:licen[cs]e|copying)(?:\.|$)/i.test(entry.path),
          )?.path || null,
        credit_text: null,
        modification_conditions: null,
        redistribution_conditions: null,
        notes:
          "Imported from a selected local folder. Creator and license details need review.",
      },
      sources,
      working_files: [
        manifest.model,
        ...(converted ? [converted.report_file] : []),
      ],
      preview: null,
      runtime: {
        path: preview_model,
        format: asset_format(preview_model),
        status: "imported-awaiting-review",
        files: [
          ...entries.map((entry) => entry.path),
          ...(converted ? [converted.path] : []),
        ],
        units: ["glb", "gltf"].includes(asset_format(preview_model))
          ? "meters"
          : "unverified",
        source_scale: 1,
        scale_verified: false,
        texture_roles_verified: false,
      },
      history: [
        {
          date: day,
          action: "import",
          description:
            "Preserved selected folder files and extracted ZIP resources; registered a preview model. Attribution requires review.",
        },
      ],
    };
    if (converted) {
      record.conversion = { source: manifest.model, ...converted };
      record.history.push({
        date: day,
        action: "derive-runtime",
        description:
          "Exported the Blender source to a separate GLB for Inventory. Evaluated modifiers for the static preview; original .blend and texture files are unchanged. Review procedural materials and scale. " +
          converted.report.warnings.join(" "),
      });
    }
    await writeFile(
      path.join(stage, "asset.json"),
      JSON.stringify(record, null, 2) + "\n",
    );
    await writeFile(
      path.join(stage, "README.md"),
      `# ${record.name}\n\nOriginal files are preserved in source/files. ZIP contents are in source/extracted.\nPreview model: ${manifest.model}. Attribution and scale require review.\nworking/ and runtime/ are reserved for editable sources and future derivatives.\n`,
    );
    if ((await readFile(index_path, "utf8")) !== raw_index)
      fail("file_conflict", 409);
    await rename(stage, destination);
    published = true;
    catalog.assets.push({ id, record: `${id}/asset.json` });
    const temp_index = path.join(root, `.catalog-${randomUUID()}.tmp`);
    try {
      await writeFile(temp_index, JSON.stringify(catalog, null, 2) + "\n", {
        flag: "wx",
      });
      await rename(temp_index, index_path);
    } catch (error) {
      await rename(destination, stage);
      published = false;
      throw error;
    } finally {
      await unlink(temp_index).catch(() => {});
    }
    return { id, duplicate: false };
  } finally {
    // Only remove this import's generated staging directory, inside the library.
    try {
      if (
        !published &&
        path.dirname(path.resolve(stage)) === root &&
        path.basename(stage).startsWith(".import-")
      ) {
        await rm(stage, { recursive: true, force: true });
      }
    } finally {
      await lock.close();
      await unlink(lock_path);
    }
  }
}
