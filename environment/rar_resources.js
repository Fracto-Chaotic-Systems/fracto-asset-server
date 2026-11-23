import { createExtractorFromData } from "node-unrar-js";
import {
  ASSET_IMPORT_LIMIT,
  ASSET_FILE_LIMIT,
  asset_relative_path,
  asset_format,
} from "@fracto/sdk/FractoAssetArchive.js";

const fail = (code) => {
  throw new Error(code);
};
/** Decode into bounded memory, never allow the archive library to write paths. */
export async function expand_rar_resources(
  entries,
  create = createExtractorFromData,
) {
  const result = [...entries];
  const names = new Set(entries.map((entry) => entry.path.toLowerCase()));
  let total = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  if (total > ASSET_IMPORT_LIMIT || entries.length > ASSET_FILE_LIMIT)
    fail("import_too_large");
  for (const archive of entries.filter(
    (entry) => asset_format(entry.path) === "rar",
  )) {
    const depth = archive.original
      ? 0
      : 1 + (archive.path.match(/\.contents\//g) || []).length;
    if (depth >= 2) fail("archive_depth");
    const base = archive.original
      ? `source/extracted/${archive.path.slice("source/files/".length, -4)}`
      : `${archive.path.slice(0, -4)}.contents`;
    let extractor, headers;
    try {
      const bytes = archive.data;
      extractor = await create({
        data: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      });
      const list = extractor.getFileList();
      if (list.arcHeader.flags.volume || list.arcHeader.flags.headerEncrypted)
        fail("invalid_archive");
      headers = [];
      for (const header of list.fileHeaders) {
        if (headers.length >= ASSET_FILE_LIMIT) fail("import_too_large");
        headers.push(header);
      }
    } catch (error) {
      if (error.message === "import_too_large") throw error;
      fail("invalid_archive");
    }
    const expected = new Map();
    let projected = total;
    for (const header of headers) {
      // Validate directory paths too; no links or special files are materialized.
      const relative = asset_relative_path(
        header.name.replaceAll("\\", "/").replace(/\/$/, ""),
      );
      if (header.flags.encrypted) fail("invalid_archive");
      if (header.flags.directory) continue;
      const name = asset_relative_path(`${base}/${relative}`),
        key = name.toLowerCase();
      if (names.has(key)) fail("duplicate_path");
      if (!Number.isSafeInteger(header.unpSize) || header.unpSize < 0)
        fail("invalid_archive");
      projected += header.unpSize;
      if (
        result.length + expected.size + 1 > ASSET_FILE_LIMIT ||
        projected > ASSET_IMPORT_LIMIT
      )
        fail("import_too_large");
      names.add(key);
      expected.set(header.name, { path: name, size: header.unpSize });
    }
    try {
      for (const file of extractor.extract().files) {
        if (file.fileHeader.flags.directory) continue;
        const entry = expected.get(file.fileHeader.name);
        if (
          !entry ||
          !(file.extraction instanceof Uint8Array) ||
          file.extraction.byteLength !== entry.size
        )
          fail("invalid_archive");
        expected.delete(file.fileHeader.name);
        total += file.extraction.byteLength;
        if (total > ASSET_IMPORT_LIMIT) fail("import_too_large");
        result.push({
          path: entry.path,
          data: file.extraction,
          original: false,
        });
      }
      if (expected.size) fail("invalid_archive");
    } catch (error) {
      if (error.message === "import_too_large") throw error;
      fail("invalid_archive");
    }
  }
  return result;
}
