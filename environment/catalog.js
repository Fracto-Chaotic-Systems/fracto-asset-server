import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  material_view,
  validate_material_edit,
} from "@fracto/sdk/FractoMaterialMetadata.js";
import { create_material_search } from "./material_search.js";
import { asset_relative_path } from "@fracto/sdk/FractoAssetArchive.js";

import {
  CATALOG_FIELDS,
  catalog_view,
  validate_catalog_edit,
  validate_model_category,
  model_category_from_path,
  normalize_model_folder,
} from "@fracto/sdk/FractoEnvironmentCatalog.js";
export { CATALOG_FIELDS } from "@fracto/sdk/FractoEnvironmentCatalog.js";
export const environment_catalog_directory = () =>
  process.env.FRACTO_ENVIRONMENT_CATALOG_DIR ||
  path.resolve(import.meta.dirname, "../models");
const revision_of = (raw) => createHash("sha256").update(raw).digest("hex");
const fail = (code, status = 400) => {
  throw Object.assign(new Error(code), { status });
};
const inside = (root, file) => {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    fail("catalog_path", 403);
  return file;
};

export function create_environment_catalog({
  directory = environment_catalog_directory(),
  now = () => new Date(),
  registry = null,
} = {}) {
  const queues = new Map();
  const locate = async (id) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) fail("invalid_asset");
    const root = await realpath(directory);
    const index_path = inside(
      root,
      await realpath(path.join(root, "catalog.json")),
    );
    const index = JSON.parse(await readFile(index_path, "utf8"));
    const item = index.assets.find((entry) => entry.id === id);
    if (!item) fail("asset_not_found", 404);
    const file = inside(root, await realpath(path.resolve(root, item.record)));
    if (path.basename(file) !== "asset.json") fail("catalog_path", 403);
    return file;
  };
  const read = async (id, sync = true, include_archived = false, signal) => {
    const file = await locate(id);
    const raw = await readFile(file, "utf8"),
      record = JSON.parse(raw);
    if (record.id !== id || record.schema_version !== 1) fail("invalid_record");
    record.model_category = validate_model_category(
      record.model_category ??
        model_category_from_path(path.relative(directory, file)),
    );
    if (registry && sync)
      await registry.sync(record, revision_of(raw), { signal });
    if (record.archived && !include_archived) fail("asset_not_found", 404);
    return { file, raw, record };
  };
  const result = ({ record, raw }) => ({
    record: catalog_view(record),
    revision: revision_of(raw),
  });
  let pending_listing = null;
  const registered_catalog = () => {
    // Listing reconciles every category, but must not flood the data service's
    // bounded connection pool. Share only in-flight work, never stale snapshots.
    if (!pending_listing)
      pending_listing = (async () => {
        const root = await realpath(directory);
        const catalog = JSON.parse(
          await readFile(
            inside(root, await realpath(path.join(root, "catalog.json"))),
            "utf8",
          ),
        );
        const registered = [];
        for (let offset = 0; offset < catalog.assets.length; offset += 4)
          registered.push(
            ...(await Promise.all(
              catalog.assets.slice(offset, offset + 4).map(async ({ id }) => {
                const { record } = await read(id, true, true);
                return {
                  archived: record.archived === true,
                  id,
                  name: record.name,
                  category: record.model_category,
                  folder_path: normalize_model_folder(record.folder_path),
                  model: record.runtime?.path || null,
                  format: record.runtime?.format || null,
                  resources:
                    record.runtime?.files ||
                    [record.runtime?.path].filter(Boolean),
                };
              }),
            )),
          );
        return registered;
      })().finally(() => {
        pending_listing = null;
      });
    return pending_listing;
  };
  const store = {
    search: create_material_search({
      index: async () => {
        const root = await realpath(directory);
        return JSON.parse(
          await readFile(
            inside(root, await realpath(path.join(root, "catalog.json"))),
            "utf8",
          ),
        ).assets;
      },
      read,
      registry,
    }),
    async get_construction(id) {
      const { record, raw } = await read(id);
      if (record.model_category !== "material") fail("asset_not_found", 404);
      return { material: material_view(record, revision_of(raw)) };
    },
    async get_construction_runtime(id, revision) {
      if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision))
        fail("invalid_record");
      const { record, raw } = await read(id);
      if (record.model_category !== "material") fail("asset_not_found", 404);
      if (revision_of(raw) !== revision) fail("material_revision_changed", 409);
      const files =
        record.runtime?.files || [record.runtime?.path].filter(Boolean);
      if (
        !Array.isArray(files) ||
        files.length > 2000 ||
        files.some(
          (file) =>
            typeof file !== "string" || asset_relative_path(file) !== file,
        )
      )
        fail("invalid_record");
      const model = record.runtime?.path || null;
      if (model && !files.includes(model)) fail("invalid_record");
      return {
        material: material_view(record, revision),
        runtime: {
          id,
          model,
          format: record.runtime?.format || null,
          resources: [...new Set(files)],
        },
      };
    },
    async update_construction(id, body) {
      const changes = validate_material_edit(body);
      const { record } = await read(id, false);
      if (record.model_category !== "material") fail("asset_not_found", 404);
      await store.update(id, {
        ...changes,
        attribution: Object.fromEntries(
          CATALOG_FIELDS.map((key) => [
            key,
            catalog_view(record).attribution[key],
          ]),
        ),
        note: "",
      });
      return store.get_construction(id);
    },
    async manage_folder(body) {
      if (!registry) fail("catalog_unavailable", 503);
      return registry.manage_folder(body);
    },
    async folders(category, folder_path) {
      if (typeof category !== "string") throw new Error("invalid_record");
      validate_model_category(category);
      if (folder_path !== undefined && !normalize_model_folder(folder_path))
        fail("invalid_folder");
      if (!registry) fail("catalog_unavailable", 503);
      return registry.folders(category, folder_path);
    },
    async list(category) {
      if (category !== undefined) validate_model_category(category);
      const registered = await registered_catalog();
      // Membership, names and category filtering come from the one database table.
      // Filesystem records supply only the registered preview resource allowlist.
      const assets = registry
        ? await registry.list(category)
        : registered.filter(
            (asset) =>
              !asset.archived && (!category || asset.category === category),
          );
      return {
        assets: assets.map((asset) => ({
          ...asset,
          resources:
            registered.find((entry) => entry.id === asset.id)?.resources || [],
        })),
      };
    },
    async file(id, relative) {
      const { record, file } = await read(id, false);
      const allowed =
        record.runtime?.files || [record.runtime?.path].filter(Boolean);
      if (!allowed.includes(relative)) fail("asset_not_found", 404);
      return inside(
        path.dirname(file),
        await realpath(path.resolve(path.dirname(file), relative)),
      );
    },
    async get(id) {
      return result(await read(id));
    },
    async update(id, body, { sync_read = true } = {}) {
      const changes = validate_catalog_edit(body);
      const previous = queues.get(id) || Promise.resolve();
      const task = previous
        .catch(() => {})
        .then(async () => {
          const original = await read(id, sync_read);
          if (revision_of(original.raw) !== body.revision)
            fail("file_conflict", 409);
          const record = structuredClone(original.record);
          const changed = CATALOG_FIELDS.some(
            (key) =>
              (record.attribution?.[key] || null) !== changes.attribution[key],
          );
          const folder_changed =
            changes.folder_path !== undefined &&
            changes.folder_path !== normalize_model_folder(record.folder_path);
          const renamed =
            changes.name !== undefined && changes.name !== record.name;
          const archived =
            changes.archived !== undefined &&
            changes.archived !== !!record.archived;
          const metadata_changed = ["description", "tags", "construction"].some(
            (key) =>
              Object.hasOwn(changes, key) &&
              JSON.stringify(changes[key]) !== JSON.stringify(record[key]),
          );
          if (
            !changed &&
            !folder_changed &&
            !renamed &&
            !archived &&
            !metadata_changed &&
            !changes.note
          )
            return result(original);
          const day = now().toISOString().slice(0, 10);
          if (metadata_changed) {
            for (const key of ["description", "tags", "construction"])
              if (Object.hasOwn(changes, key)) record[key] = changes[key];
            record.history.push({
              date: day,
              action: "update-construction-metadata",
              description: "Updated material search and construction metadata.",
            });
          }
          if (renamed) {
            record.name = changes.name;
            record.history.push({
              date: day,
              action: "rename-model",
              description: "Updated the model display name.",
            });
          }
          if (archived) {
            record.archived = changes.archived;
            record.history.push({
              date: day,
              action: "delete-model",
              description:
                "Removed the model from the inventory; files and provenance retained.",
            });
          }
          if (changed) {
            record.attribution = {
              ...record.attribution,
              ...changes.attribution,
              status: [
                "creator_name",
                "source_url",
                "license_name",
                "credit_text",
              ].every((key) => changes.attribution[key])
                ? "recorded-unverified"
                : "unresolved",
            };
            record.history.push({
              date: day,
              action: "update-attribution",
              description: "Updated catalog attribution details.",
            });
          }
          if (folder_changed) {
            record.folder_path = changes.folder_path;
            record.history.push({
              date: day,
              action: "move-folder",
              description: "Updated the asset's logical folder.",
            });
          }
          if (changes.note)
            record.history.push({
              date: day,
              action: "catalog-note",
              description: changes.note,
            });
          const raw = JSON.stringify(record, null, 2) + "\n";
          const temporary = path.join(
            path.dirname(original.file),
            `.asset-${randomUUID()}.tmp`,
          );
          try {
            await writeFile(temporary, raw, { flag: "wx", mode: 0o600 });
            // Keep external edits made while the update was prepared.
            if (
              revision_of(await readFile(original.file, "utf8")) !==
              body.revision
            )
              fail("file_conflict", 409);
            await rename(temporary, original.file);
          } finally {
            await unlink(temporary).catch(() => {});
          }
          if (registry) {
            try {
              await registry.sync(record, revision_of(raw));
            } catch (error) {
              error.published = result({ record, raw });
              throw error;
            }
          }
          return result({ record, raw });
        });
      queues.set(id, task);
      try {
        return await task;
      } finally {
        if (queues.get(id) === task) queues.delete(id);
      }
    },
  };
  return store;
}
