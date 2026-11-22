import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync, strToU8, unzipSync } from "fflate";
import { convert_blend_asset } from "../environment/blender_conversion.js";
import { import_environment_asset } from "../environment/import.js";
import { expand_asset_files } from "@fracto/sdk/FractoAssetArchive.js";
const fake_glb = () => {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(20, 8);
  return bytes;
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "fracto-blend-conversion-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("fracto-blend-conversion-"));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "runtime"));
  await mkdir(path.join(root, "working"));
  return root;
}

test("Blender wrapper disables embedded scripts, bounds execution and validates the separate GLB", async (t) => {
  const root = await fixture(t);
  const result = await convert_blend_asset({
    root,
    source: "source/files/grass.blend",
    binary: "configured-blender",
    execute: async (binary, args, options) => {
      assert.equal(binary, "configured-blender");
      assert.ok(args.includes("--disable-autoexec"));
      assert.ok(args.includes("--factory-startup"));
      assert.ok(!args.includes("--enable-autoexec"));
      assert.equal(options.timeout, 120000);
      assert.equal(options.windowsHide, true);
      const parameters = args.slice(args.indexOf("--") + 1);
      assert.equal(parameters[0], path.join(root, "source/files/grass.blend"));
      await writeFile(parameters[1], fake_glb());
      await writeFile(
        parameters[2],
        JSON.stringify({ warnings: [], original_saved: false }),
      );
    },
  });
  assert.equal(result.path, "runtime/model.glb");
  assert.equal(result.report.original_saved, false);
});

test("Blender launch failures and conversion reports yield actionable error codes", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    convert_blend_asset({
      root,
      source: "source/files/grass.blend",
      execute: async () => {
        throw Object.assign(new Error("missing binary"), { code: "ENOENT" });
      },
    }),
    /blender_unavailable/,
  );
  await writeFile(
    path.join(root, "working/blender-export.json"),
    JSON.stringify({ error: "blender_missing_textures" }),
  );
  await assert.rejects(
    convert_blend_asset({
      root,
      source: "source/files/grass.blend",
      execute: async () => {
        throw Error("process failed");
      },
    }),
    /blender_missing_textures/,
  );
  await assert.rejects(
    convert_blend_asset({
      root,
      source: "source/files/grass.blend",
      execute: async () => {},
    }),
    /blender_conversion_failed/,
  );
});

test("blend-only folders are accepted and register a converted preview without changing the originals", async (t) => {
  const root = await fixture(t),
    original = strToU8("BLENDER-v292 original bytes");
  const files = [
    { path: "grass.blend", data: original },
    { path: "grass.jpg", data: new Uint8Array([1, 2, 3]) },
  ];
  assert.deepEqual(expand_asset_files(files, unzipSync).models, [
    "source/files/grass.blend",
  ]);
  await writeFile(
    path.join(root, "catalog.json"),
    JSON.stringify({ schema_version: 1, assets: [] }),
  );
  const upload = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        name: "Blend grass",
        model: "source/files/grass.blend",
      }),
    ),
    ...Object.fromEntries(
      files.map((file) => ["files/" + file.path, file.data]),
    ),
  });
  const saved = await import_environment_asset(root, upload, {
    convert_blend: async ({ root: stage, source }) => {
      assert.equal(source, "source/files/grass.blend");
      await writeFile(path.join(stage, "runtime/model.glb"), fake_glb());
      await writeFile(path.join(stage, "working/blender-export.json"), "{}");
      return {
        path: "runtime/model.glb",
        format: "glb",
        report_file: "working/blender-export.json",
        report: { warnings: ["Particle density reduced for preview."] },
      };
    },
  });
  const directory = path.join(root, "ingredients", saved.id),
    record = JSON.parse(
      await readFile(path.join(directory, "asset.json"), "utf8"),
    );
  assert.deepEqual(
    new Uint8Array(
      await readFile(path.join(directory, "source/files/grass.blend")),
    ),
    original,
  );
  assert.equal(record.runtime.path, "runtime/model.glb");
  assert.equal(record.runtime.format, "glb");
  assert.ok(record.working_files.includes("source/files/grass.blend"));
  assert.match(record.history.at(-1).description, /Particle density reduced/);
  assert.ok(record.runtime.files.includes("runtime/model.glb"));
});

test("failed Blender conversions do not publish a partial asset or leave an import lock", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "catalog.json"),
    JSON.stringify({ schema_version: 1, assets: [] }),
  );
  const before = await readdir(root);
  const upload = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({ name: "Failed", model: "source/files/grass.blend" }),
    ),
    "files/grass.blend": strToU8("BLENDER-v292"),
  });
  await assert.rejects(
    import_environment_asset(root, upload, {
      convert_blend: async () => {
        throw Error("blender_conversion_failed");
      },
    }),
    /blender_conversion_failed/,
  );
  assert.deepEqual(await readdir(root), before);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8")).assets
      .length,
    0,
  );
});
