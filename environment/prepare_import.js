import { unzipSync } from "fflate";
import {
  asset_model_paths,
  bounded_unzip,
  expand_asset_files,
} from "@fracto/sdk/FractoAssetArchive.js";
import { validate_model_category } from "@fracto/sdk/FractoEnvironmentCatalog.js";
import { expand_rar_resources } from "./rar_resources.js";

// Shared preparation for read-only inspection and publication. Decode once per
// request, preserving the original archive and applying the same bounds to both.
export async function prepare_environment_import(
  upload,
  expand_resources = expand_rar_resources,
) {
  let envelope;
  try {
    envelope = bounded_unzip(upload, unzipSync);
  } catch (error) {
    if (
      ["unsafe_path", "duplicate_path", "import_too_large"].includes(
        error.message,
      )
    )
      throw error;
    throw Error("invalid_archive");
  }
  if (!envelope["manifest.json"] || envelope["manifest.json"].length > 4096)
    throw new Error("invalid_import");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(envelope["manifest.json"]));
  } catch {
    throw new Error("invalid_import");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("invalid_import");
  const category = validate_model_category(manifest.model_category);
  const originals = Object.entries(envelope)
    .filter(([name]) => name.startsWith("files/"))
    .map(([name, data]) => ({ path: name.slice(6), data }));
  const expanded = expand_asset_files(originals, unzipSync, {
    allow_no_model: true,
  });
  const entries = await expand_resources(expanded.entries);
  return { manifest, category, entries, models: asset_model_paths(entries) };
}

export async function inspect_environment_import(upload, options = {}) {
  const { models } = await prepare_environment_import(
    upload,
    options.expand_resources,
  );
  return { models };
}
