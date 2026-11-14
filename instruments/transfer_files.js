import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { transfer_error } from "../../../utils/instrument_transfer.js";

const stamp = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
// Preview never creates directories/files, including for an empty receiver.
export async function safe_transfer_path(root, relative = "") {
  const absolute = path.resolve(root, relative);
  const base = path.resolve(root);
  if (absolute !== base && !absolute.startsWith(base + path.sep))
    throw transfer_error("invalid_path", 400);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of path
    .relative(parsed.root, absolute)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (
        stat.isSymbolicLink() ||
        (current !== absolute && !stat.isDirectory())
      )
        throw transfer_error("invalid_path", 400);
    } catch (error) {
      if (error.code === "ENOENT") return absolute;
      throw error;
    }
  }
  return absolute;
}
export async function observe_transfer_file(
  root,
  relative,
  { signal, max_bytes, text = false } = {},
) {
  signal?.throwIfAborted();
  const filename = await safe_transfer_path(root, relative);
  let handle;
  try {
    handle = await fsp.open(
      filename,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (["EPERM", "EACCES"].includes(error.code))
      throw transfer_error("storage_not_ready", 503);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw transfer_error("invalid_path", 400);
    if (before.size > BigInt(max_bytes))
      throw transfer_error("limit_exceeded", 413);
    const hash = createHash("sha256");
    const chunks = [];
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, 0, buffer.length, bytes);
      if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      bytes += result.bytesRead;
      if (bytes > max_bytes) throw transfer_error("limit_exceeded", 413);
      hash.update(chunk);
      if (text) chunks.push(Buffer.from(chunk));
    }
    await safe_transfer_path(root, relative);
    const after = await fsp.stat(filename, { bigint: true });
    if (stamp(before) !== stamp(after) || BigInt(bytes) !== before.size)
      throw transfer_error("snapshot_changed");
    return {
      sha256: hash.digest("hex"),
      bytes,
      ...(text
        ? {
            text: new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          }
        : {}),
    };
  } finally {
    await handle.close();
  }
}
export async function transfer_storage(root, persistent) {
  try {
    await safe_transfer_path(root);
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error("not directory");
    await fsp.access(root, fs.constants.R_OK | fs.constants.W_OK);
    const space = await fsp.statfs(root, { bigint: true });
    const free = space.bavail * space.bsize;
    return {
      free_bytes: Number(
        free > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : free,
      ),
      ready: persistent === true,
    };
  } catch {
    return { free_bytes: 0, ready: false };
  }
}
