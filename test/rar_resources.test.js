import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { expand_rar_resources } from "../environment/rar_resources.js";
import { import_environment_asset } from "../environment/import.js";
import { repair_environment_archives } from "../environment/repair_archives.js";
import { writeFile } from "node:fs/promises";

// Minimal stored RAR4 fixture; no downloaded model or texture is redistributed.
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
function rar(files) {
  const header = (type, flags, body) => {
    const data = Buffer.alloc(7 + body.length);
    data[2] = type;
    data.writeUInt16LE(flags, 3);
    data.writeUInt16LE(data.length, 5);
    body.copy(data, 7);
    data.writeUInt16LE(crc32(data.subarray(2)) & 0xffff);
    return data;
  };
  const parts = [
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0]),
    header(0x73, 0, Buffer.alloc(6)),
  ];
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text),
      filename = Buffer.from(name),
      body = Buffer.alloc(25 + filename.length);
    body.writeUInt32LE(bytes.length, 0);
    body.writeUInt32LE(bytes.length, 4);
    body[8] = 2;
    body.writeUInt32LE(crc32(bytes), 9);
    body[17] = 20;
    body[18] = 0x30;
    body.writeUInt16LE(filename.length, 19);
    body.writeUInt32LE(0x20, 21);
    filename.copy(body, 25);
    parts.push(header(0x74, 0x8000, body), bytes);
  }
  parts.push(header(0x7b, 0, Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const entry = (data) => ({
  path: "source/files/textures.rar",
  data,
  original: true,
});

test("real RAR resources expand in memory into portable paths and preserve archive bytes", async () => {
  const archive = rar({
    "tex\\leaf.png": "image-data",
    "readme.txt": "Credit details",
  });
  const result = await expand_rar_resources([entry(archive)]);
  assert.equal(result[0].data, archive);
  assert.equal(result[1].path, "source/extracted/textures/tex/leaf.png");
  assert.equal(Buffer.from(result[1].data).toString(), "image-data");
  assert.equal(result[1].original, false);
  assert.equal(result.length, 3);
});

test("RAR validation rejects traversal, duplicates, encryption and oversized headers before extraction", async () => {
  for (const name of ["../outside.png", "/outside.png", "C:\\outside.png"])
    await assert.rejects(
      expand_rar_resources([entry(rar({ [name]: "x" }))]),
      /unsafe_path/,
    );
  await assert.rejects(
    expand_rar_resources([entry(rar({ "leaf.png": "x", "LEAF.png": "y" }))]),
    /duplicate_path/,
  );
  let extracted = false;
  const fake = (header) => async () => ({
    getFileList: () => ({ arcHeader: { flags: {} }, fileHeaders: [header] }),
    extract() {
      extracted = true;
      return { files: [] };
    },
  });
  await assert.rejects(
    expand_rar_resources(
      [entry(Buffer.from("x"))],
      fake({ name: "huge.png", unpSize: 101 * 1024 * 1024, flags: {} }),
    ),
    /import_too_large/,
  );
  assert.equal(extracted, false);
  await assert.rejects(
    expand_rar_resources(
      [entry(Buffer.from("x"))],
      fake({ name: "locked.png", unpSize: 1, flags: { encrypted: true } }),
    ),
    /invalid_archive/,
  );
  assert.equal(extracted, false);
  await assert.rejects(
    expand_rar_resources([entry(Buffer.from("not-rar"))]),
    /invalid_archive/,
  );
});

test("import extracts RAR resources and repair upgrades old records idempotently without changing attribution", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "fracto-rar-fixture-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("fracto-rar-fixture-"));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(directory, "catalog.json"),
    JSON.stringify({ assets: [] }),
  );
  const upload = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({ name: "Fern", model: "source/files/fern.obj" }),
    ),
    "files/fern.obj": strToU8("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
    "files/textures.rar": rar({ "leaf.png": "image-data" }),
  });
  const result = await import_environment_asset(directory, upload, {
    expand_resources: async (entries) => entries,
  });
  const file = path.join(directory, "ingredients", result.id, "asset.json");
  const original = JSON.parse(await readFile(file, "utf8"));
  const fixed = await repair_environment_archives({ directory, id: result.id });
  assert.equal(fixed.added.length, 1);
  const updated = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(updated.sources, original.sources);
  assert.deepEqual(updated.attribution, original.attribution);
  assert.equal(updated.runtime.path, original.runtime.path);
  assert.equal(updated.history.length, original.history.length + 1);
  assert.ok(
    updated.runtime.files.includes("source/extracted/textures/leaf.png"),
  );
  assert.deepEqual(
    (await repair_environment_archives({ directory, id: result.id })).added,
    [],
  );
  assert.equal(
    await readFile(file, "utf8"),
    JSON.stringify(updated, null, 2) + "\n",
  );
  const another = await mkdtemp(path.join(tmpdir(), "fracto-rar-fixture-"));
  t.after(async () => {
    assert.equal(path.dirname(another), path.resolve(tmpdir()));
    assert.ok(path.basename(another).startsWith("fracto-rar-fixture-"));
    await rm(another, { recursive: true, force: true });
  });
  await writeFile(
    path.join(another, "catalog.json"),
    JSON.stringify({ assets: [] }),
  );
  const imported = await import_environment_asset(another, upload);
  const live = JSON.parse(
    await readFile(
      path.join(another, "ingredients", imported.id, "asset.json"),
      "utf8",
    ),
  );
  assert.ok(live.runtime.files.includes("source/extracted/textures/leaf.png"));
  assert.equal(live.sources.length, 2);
});
