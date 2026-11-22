import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { package_dependencies } from "./transfer_package.js";
import { observe_transfer_file, safe_transfer_path } from "./transfer_files.js";
import {
  receive_staged_file,
  source_file_chunks,
  staging_path,
} from "./transfer_staging.js";
import { install_link } from "./transfer_persistence.js";
import {
  transfer_hash,
  transfer_error,
  TRANSFER_LIMITS,
} from "@fracto/sdk/utils/InstrumentTransfer.js";

// Copy only catalog-owned data into a new persistent volume. Code stays in the
// image so volume contents cannot freeze old JS across an image upgrade.
export async function initialize_instrument_storage({
  directory = process.env.FRACTO_INSTRUMENT_DIR,
  source = fileURLToPath(new URL("./", import.meta.url)),
  persistent = process.env.FRACTO_INSTRUMENT_TRANSFER_PERSISTENT === "true",
} = {}) {
  if (
    !directory ||
    !persistent ||
    path.resolve(directory) === path.resolve(source)
  )
    return;
  await safe_transfer_path(directory);
  await fsp.mkdir(directory, { recursive: true });
  if (
    await observe_transfer_file(directory, "catalog.json", {
      max_bytes: 32 * 1024 * 1024,
    })
  )
    return;
  // A transfer journal owns an initialized volume even when its catalog commit
  // was interrupted. Image bootstrap must never perform that pending commit.
  const sessions = await safe_transfer_path(
    directory,
    ".instrument-transfer/sessions",
  );
  try {
    if ((await fsp.readdir(sessions)).some((name) => name.endsWith(".json")))
      return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const catalog = await observe_transfer_file(source, "catalog.json", {
    max_bytes: 32 * 1024 * 1024,
    text: true,
  });
  if (!catalog) return; // Empty installations can receive a whole package later.
  const { files } = package_dependencies(catalog.text);
  const descriptors = [];
  for (const expected of files.values()) {
    const observed = await observe_transfer_file(
      source,
      expected.relative_path,
      { max_bytes: TRANSFER_LIMITS.file_bytes },
    );
    if (!observed) {
      if (["original", "playback"].includes(expected.kind)) continue;
      throw transfer_error("source_incomplete", 422);
    }
    if (
      (expected.sha256 && expected.sha256 !== observed.sha256) ||
      (expected.bytes !== null && expected.bytes !== observed.bytes)
    )
      throw transfer_error("source_incomplete", 422);
    descriptors.push({
      file_id: transfer_hash(expected.relative_path),
      kind: expected.kind,
      relative_path: expected.relative_path,
      ...observed,
    });
  }
  descriptors.sort(
    (a, b) => Number(a.kind === "catalog") - Number(b.kind === "catalog"),
  );
  for (const file of descriptors) {
    const current = await observe_transfer_file(directory, file.relative_path, {
      max_bytes: file.bytes,
    });
    if (current) {
      if (current.sha256 !== file.sha256 || current.bytes !== file.bytes)
        throw transfer_error("file_conflict");
      continue;
    }
    await receive_staged_file(
      directory,
      catalog.sha256,
      file,
      Readable.from(source_file_chunks(source, file), {
        objectMode: false,
        highWaterMark: 64 * 1024,
      }),
    );
    await install_link(directory, staging_path(catalog.sha256, file), file);
  }
}
