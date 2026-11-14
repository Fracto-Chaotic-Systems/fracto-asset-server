import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safe_transfer_path, observe_transfer_file } from "./transfer_files.js";
import { transfer_parent, sync_directory } from "./transfer_staging.js";
import { transfer_error } from "../../../utils/instrument_transfer.js";

export async function durable_file(
  root,
  relative,
  bytes,
  { replace = false } = {},
) {
  await transfer_parent(root, relative);
  const target = await safe_transfer_path(root, relative);
  const temporary = `${relative}.${randomUUID()}.part`;
  const temp = await safe_transfer_path(root, temporary);
  let handle;
  try {
    handle = await fsp.open(temp, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await safe_transfer_path(root, relative);
    if (replace) {
      const existing = await fsp.lstat(target).catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      });
      if (existing && !existing.isFile())
        throw transfer_error("invalid_path", 400);
      await fsp.rename(temp, target);
    } else await fsp.link(temp, target);
    await sync_directory(path.dirname(target));
  } finally {
    await handle?.close();
    await safe_transfer_path(root, temporary);
    await fsp.unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export async function install_link(
  root,
  source_relative,
  file,
  on_change = () => {},
) {
  const observed = await observe_transfer_file(root, file.relative_path, {
    max_bytes: file.bytes,
  });
  if (observed) {
    if (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes)
      throw transfer_error("file_conflict");
    return;
  }
  await transfer_parent(root, file.relative_path);
  const source = await safe_transfer_path(root, source_relative);
  const target = await safe_transfer_path(root, file.relative_path);
  try {
    await fsp.link(source, target);
    on_change();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const current = await observe_transfer_file(root, file.relative_path, {
      max_bytes: file.bytes,
    });
    if (current?.sha256 !== file.sha256 || current.bytes !== file.bytes)
      throw transfer_error("file_conflict");
  }
  await sync_directory(path.dirname(target));
}

export async function remove_candidate(root, relative) {
  if (
    !/^\.instrument-transfer\/candidates\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      relative,
    )
  )
    throw transfer_error("invalid_path", 400);
  const absolute = await safe_transfer_path(root, relative);
  const expected_parent = path.resolve(root, ".instrument-transfer/candidates");
  if (path.dirname(absolute) !== expected_parent)
    throw transfer_error("invalid_path", 400);
  async function remove(directory) {
    for (const child of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, child.name);
      await safe_transfer_path(root, path.relative(path.resolve(root), target));
      if (child.isDirectory()) await remove(target);
      else if (child.isFile()) await fsp.unlink(target);
      else throw transfer_error("invalid_path", 400);
    }
    await fsp.rmdir(directory);
  }
  await remove(absolute);
}
