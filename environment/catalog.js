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
  CATALOG_FIELDS,
  catalog_view,
  validate_catalog_edit,
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
  const read = async (id, sync = true) => {
    const file = await locate(id);
    const raw = await readFile(file, "utf8"),
      record = JSON.parse(raw);
    if (record.id !== id || record.schema_version !== 1) fail("invalid_record");
    if (registry && sync) await registry.sync(record, revision_of(raw));
    return { file, raw, record };
  };
  const result = ({ record, raw }) => ({
    record: catalog_view(record),
    revision: revision_of(raw),
  });
  return {
    async list() {
      const root = await realpath(directory);
      const catalog = JSON.parse(
        await readFile(
          inside(root, await realpath(path.join(root, "catalog.json"))),
          "utf8",
        ),
      );
      return {
        assets: await Promise.all(
          catalog.assets.map(async ({ id }) => {
            const { record } = await read(id);
            return {
              id,
              name: record.name,
              model: record.runtime?.path || null,
              format: record.runtime?.format || null,
              resources:
                record.runtime?.files || [record.runtime?.path].filter(Boolean),
            };
          }),
        ),
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
    async update(id, body) {
      const changes = validate_catalog_edit(body);
      const previous = queues.get(id) || Promise.resolve();
      const task = previous
        .catch(() => {})
        .then(async () => {
          const original = await read(id);
          if (revision_of(original.raw) !== body.revision)
            fail("file_conflict", 409);
          const record = structuredClone(original.record);
          const changed = CATALOG_FIELDS.some(
            (key) =>
              (record.attribution?.[key] || null) !== changes.attribution[key],
          );
          if (!changed && !changes.note) return result(original);
          const day = now().toISOString().slice(0, 10);
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
          if (registry) await registry.sync(record, revision_of(raw));
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
}
