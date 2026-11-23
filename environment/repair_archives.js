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
import { expand_rar_resources } from "./rar_resources.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const inside = (root, file) => {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    fail("unsafe_path");
  return file;
};

/** Service-owned repair for already imported archives; all original bytes survive. */
export async function repair_environment_archives({ directory, id, registry }) {
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
    fail("invalid_asset");
  const library = await realpath(directory);
  const index = JSON.parse(
    await readFile(path.join(library, "catalog.json"), "utf8"),
  );
  const item = index.assets.find((asset) => asset.id === id);
  if (!item) fail("asset_not_found");
  const file = inside(
    library,
    await realpath(path.join(library, asset_relative_path(item.record))),
  );
  if (path.basename(file) !== "asset.json") fail("unsafe_path");
  const raw = await readFile(file, "utf8"),
    record = JSON.parse(raw);
  if (record.id !== id || record.schema_version !== 1) fail("invalid_record");
  const root = path.dirname(file),
    entries = [];
  let total = 0;
  for (const relative of [
    ...new Set([
      ...(record.runtime.files || []),
      ...record.sources.map((source) => source.path),
    ]),
  ]) {
    const name = asset_relative_path(relative);
    const absolute = inside(root, await realpath(path.join(root, name)));
    const data = await readFile(absolute);
    total += data.length;
    if (total > ASSET_IMPORT_LIMIT) fail("import_too_large");
    entries.push({
      path: name,
      data,
      original: record.sources.some((source) => source.path === name),
    });
  }
  // Existing derived files are verified and included without duplicate extraction.
  const existing = new Map(entries.map((entry) => [entry.path, entry]));
  const originals = entries.filter((entry) => entry.original);
  const expanded = await expand_rar_resources(originals);
  const added = [];
  for (const entry of expanded.filter((entry) => !entry.original)) {
    if (existing.has(entry.path)) {
      if (hash(existing.get(entry.path).data) !== hash(entry.data))
        fail("file_conflict");
      continue;
    }
    const destination = inside(root, path.resolve(root, entry.path));
    await mkdir(path.dirname(destination), { recursive: true });
    inside(root, await realpath(path.dirname(destination)));
    try {
      await writeFile(destination, entry.data, { flag: "wx" });
    } catch (error) {
      if (
        error.code !== "EEXIST" ||
        hash(await readFile(inside(root, await realpath(destination)))) !==
          hash(entry.data)
      )
        throw error;
    }
    added.push(entry.path);
  }
  if (added.length) {
    record.runtime.files = [
      ...new Set([...(record.runtime.files || []), ...added]),
    ];
    record.history.push({
      date: new Date().toISOString().slice(0, 10),
      action: "extract-archive",
      description:
        "Extracted preserved RAR resources for the preview; original model, archive and attribution unchanged.",
    });
    const updated = JSON.stringify(record, null, 2) + "\n",
      temporary = path.join(root, `.asset-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, updated, { flag: "wx" });
      if (hash(await readFile(file)) !== hash(Buffer.from(raw)))
        fail("file_conflict");
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    if (registry) await registry.sync(record, hash(Buffer.from(updated)));
  } else if (registry) await registry.sync(record, hash(Buffer.from(raw)));
  return { id, added };
}
