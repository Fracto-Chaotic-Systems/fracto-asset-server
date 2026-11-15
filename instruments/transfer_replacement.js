import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { observe_transfer_file, safe_transfer_path } from "./transfer_files.js";
import { transfer_parent, sync_directory } from "./transfer_staging.js";
import {
  TRANSFER_LIMITS,
  transfer_error,
} from "../../../utils/instrument_transfer.js";

// Compare live bytes with the approved preview, not with an arbitrary current file.
export async function assert_observation(root, file, expected, signal) {
  const current = await observe_transfer_file(root, file.relative_path, {
    signal,
    max_bytes: TRANSFER_LIMITS.file_bytes,
  });
  if (
    (current?.sha256 ?? null) !== expected.sha256 ||
    (current?.bytes ?? null) !== expected.bytes
  )
    throw transfer_error("snapshot_changed");
  return current;
}

export async function backup_observation(root, file, expected, relative) {
  const current = await assert_observation(root, file, expected);
  if (!current) return;
  await transfer_parent(root, relative);
  const backup = await safe_transfer_path(root, relative);
  try {
    await fsp.link(await safe_transfer_path(root, file.relative_path), backup);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const proof = await observe_transfer_file(root, relative, {
    max_bytes: TRANSFER_LIMITS.file_bytes,
  });
  if (proof?.sha256 !== expected.sha256 || proof.bytes !== expected.bytes)
    throw transfer_error("verification_failed", 503);
  const handle = await fsp.open(
    backup,
    process.platform === "win32" ? "r+" : "r",
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await sync_directory(path.dirname(backup));
  await assert_observation(root, file, expected);
}

// A verified candidate inode replaces a file only after its old inode is backed up.
// Renaming never edits bytes in place, so retained backups and open readers survive.
export async function install_replacement(
  root,
  source_relative,
  file,
  expected,
  backup_relative,
  on_change,
) {
  const current = await assert_observation(root, file, expected);
  if (current?.sha256 === file.sha256 && current.bytes === file.bytes) return;
  if (current) await backup_observation(root, file, expected, backup_relative);
  await transfer_parent(root, file.relative_path);
  const relative = `${file.relative_path}.${randomUUID()}.part`;
  const temporary = await safe_transfer_path(root, relative);
  try {
    await fsp.link(await safe_transfer_path(root, source_relative), temporary);
    await assert_observation(root, file, expected);
    await fsp.rename(
      temporary,
      await safe_transfer_path(root, file.relative_path),
    );
    on_change();
    await sync_directory(path.dirname(temporary));
  } finally {
    await safe_transfer_path(root, relative);
    await fsp.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
