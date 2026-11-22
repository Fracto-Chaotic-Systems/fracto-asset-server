import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safe_transfer_path, observe_transfer_file } from "./transfer_files.js";
import {
  transfer_error,
  TRANSFER_LIMITS,
} from "@fracto/sdk/utils/InstrumentTransfer.js";
import { transfer_deadline } from "@fracto/sdk/utils/InstrumentTransferStream.js";

import { staging_path } from "@fracto/sdk/utils/InstrumentTransfer.js";
export { staging_path } from "@fracto/sdk/utils/InstrumentTransfer.js";
const stamp = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
export async function observe_staged(root, manifest_sha256, file, signal) {
  return observe_transfer_file(root, staging_path(manifest_sha256, file), {
    signal,
    max_bytes: TRANSFER_LIMITS.file_bytes,
  });
}
export async function transfer_parent(root, relative) {
  const parent = path.posix.dirname(relative);
  let current = "";
  for (const part of parent.split("/")) {
    current = current ? `${current}/${part}` : part;
    const directory = await safe_transfer_path(root, current);
    try {
      await fsp.mkdir(directory);
      await sync_directory(path.dirname(directory));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await safe_transfer_path(root, current);
    if (!(await fsp.stat(directory)).isDirectory())
      throw transfer_error("invalid_path", 400);
  }
  if (
    (await fsp.stat(root)).dev !== (await fsp.stat(path.join(root, parent))).dev
  )
    throw transfer_error("storage_not_ready", 503);
}
export async function sync_directory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(
      ["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error.code) &&
      process.platform === "win32"
    ))
      throw error;
  } finally {
    await handle?.close();
  }
}
export async function receive_staged_file(
  root,
  manifest_sha256,
  file,
  input,
  { signal, touch = () => {}, on_commit = () => {} } = {},
) {
  // Cancellation may arrive after opening the partial but before async iteration
  // installs its error listener. Iteration still receives the stored stream error.
  const observe_error = () => {};
  input.on("error", observe_error);
  input.once("close", () => input.off("error", observe_error));
  const relative = staging_path(manifest_sha256, file);
  await transfer_parent(root, relative);
  const final = await safe_transfer_path(root, relative);
  const temporary = `${final}.${randomUUID()}.part`;
  let handle,
    installed = false;
  const deadline = transfer_deadline(signal);
  const abort = () => input.destroy(deadline.signal.reason);
  deadline.signal.addEventListener("abort", abort, { once: true });
  try {
    deadline.signal.throwIfAborted();
    handle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of input) {
      deadline.signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > file.bytes) throw transfer_error("checksum_mismatch", 422);
      hash.update(chunk);
      for (let offset = 0; offset < chunk.length;) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        if (!result.bytesWritten)
          throw transfer_error("storage_not_ready", 503);
        offset += result.bytesWritten;
      }
      deadline.touch();
      touch();
    }
    if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
      throw transfer_error("checksum_mismatch", 422);
    deadline.signal.throwIfAborted();
    await handle.sync();
    await handle.close();
    handle = null;
    await safe_transfer_path(root, relative);
    try {
      await fsp.link(temporary, final);
      installed = true;
      on_commit();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await observe_staged(
        root,
        manifest_sha256,
        file,
        deadline.signal,
      );
      if (previous?.sha256 !== file.sha256 || previous.bytes !== file.bytes) {
        await safe_transfer_path(root, relative);
        await fsp.rename(temporary, final);
        installed = true;
        on_commit();
      }
    }
    await sync_directory(path.dirname(final));
    return {
      protocol_version: 1,
      file_id: file.file_id,
      sha256: file.sha256,
      bytes,
      disposition: installed ? "staged" : "already_present",
    };
  } catch (error) {
    if (error.code === "ENOSPC")
      throw transfer_error("insufficient_space", 507);
    if (["EACCES", "EPERM", "EXDEV", "ENOTSUP"].includes(error.code))
      throw transfer_error("storage_not_ready", 503);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", abort);
    deadline.close();
    await handle?.close();
    // Only the exclusively-created, service-owned partial path is removed.
    await safe_transfer_path(
      root,
      path.relative(path.resolve(root), temporary),
    );
    await fsp.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

// Hold the final chunk until the complete hash and file identity have been checked.
// A changed source cannot send a full Content-Length followed by a late error.
export async function* source_file_chunks(
  root,
  file,
  { signal, touch = () => {} } = {},
) {
  const filename = await safe_transfer_path(root, file.relative_path);
  const handle = await fsp.open(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  const deadline = transfer_deadline(signal);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(file.bytes))
      throw transfer_error("snapshot_changed");
    const hash = createHash("sha256");
    let bytes = 0;
    while (bytes < file.bytes) {
      deadline.signal.throwIfAborted();
      const chunk = Buffer.allocUnsafe(
        Math.min(1024 * 1024, file.bytes - bytes),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (!bytesRead) throw transfer_error("snapshot_changed");
      const data = chunk.subarray(0, bytesRead);
      hash.update(data);
      bytes += bytesRead;
      if (bytes === file.bytes) {
        await safe_transfer_path(root, file.relative_path);
        if (
          hash.digest("hex") !== file.sha256 ||
          stamp(before) !== stamp(await fsp.stat(filename, { bigint: true }))
        )
          throw transfer_error("snapshot_changed");
      }
      deadline.touch();
      touch();
      yield data;
    }
  } finally {
    deadline.close();
    await handle.close();
  }
}
