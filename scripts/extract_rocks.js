import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { CATALOG_FIELDS } from "@fracto/sdk/FractoEnvironmentCatalog.js";
import { split_glb_meshes, read_glb } from "../environment/split_glb_meshes.js";
const server =
    process.env.FRACTO_ROCK_ASSET_URL ??
    "http://localhost:3103/environment-catalog",
  sourceId = "rocks",
  sourceRevision =
    "66ca8209def0dd483e5a9b329e6c310f575f2084078d4f259d29144dfa5efa49",
  publish = process.argv.includes("--publish");
async function request(path, options = {}) {
  const r = await fetch(server + path, {
    ...options,
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw Error(`${r.status} ${path}: ${await r.text()}`);
  return r;
}
const source = await (await request("/" + sourceId)).json();
if (source.revision !== sourceRevision)
  throw Error("Source catalog revision changed");
const runtime = await (
    await request("/rocks/construction/runtime?revision=" + sourceRevision)
  ).json(),
  bytes = Buffer.from(
    await (
      await request("/rocks/files/" + runtime.runtime.model)
    ).arrayBuffer(),
  ),
  parts = split_glb_meshes(bytes),
  extras = read_glb(bytes).json.asset.extras;
if (
  parts.length !== 84 ||
  new Set(parts.map((p) => p.source_mesh_index)).size !== 84 ||
  new Set(parts.map((p) => p.geometry_sha256)).size !== 84
)
  throw Error("Expected 84 unique original rock meshes");
const directory = new URL("../runtime/rock-extraction/", import.meta.url);
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(
  new URL("README.md", directory),
  "# Extracted rock working artifacts\n\nPrepared through the asset service from its registered rocks array. Original geometry and embedded images survive unchanged. Each normalized part is one metre across its longest XZ extent before component scale. Publication uses the existing import/catalog APIs; original array files are never overwritten.\n",
);
const report = {
  source: {
    id: sourceId,
    revision: sourceRevision,
    glb_sha256: createHash("sha256").update(bytes).digest("hex"),
    credit: extras,
  },
  normalization:
    "Original hierarchy retained; new root centers XZ, grounds minimum Y, and normalizes maximum XZ extent to 1m. Component scales define intended physical pebble diameter.",
  parts: [],
};
for (const part of parts) {
  const name = "rocks-piece-" + String(part.ordinal).padStart(3, "0"),
    { bytes: glb, ...metadata } = part;
  await fs.writeFile(new URL(name + ".glb", directory), glb);
  let asset = null;
  if (publish) {
    const credit = `${extras.author}\n${extras.title}\n${extras.source}\n${extras.license}\nModification: isolated original mesh ${part.source_mesh_index} (${part.source_node_name}); centered/grounded and normalized to a one-metre horizontal extent for calibrated component placement. Original geometry, UVs, normal maps and image bytes retained.\n`;
    const zip = zipSync({
      "manifest.json": strToU8(
        JSON.stringify({
          name,
          model: "source/files/rock.glb",
          model_category: "material",
        }),
      ),
      "files/rock.glb": new Uint8Array(glb),
      "files/credits.txt": strToU8(credit),
    });
    const imported = await (
      await request("/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          Origin: "http://localhost:3106",
        },
        body: zip,
      })
    ).json();
    if (imported.id !== name) throw Error("Asset ID collision: " + imported.id);
    const current = await (await request("/" + imported.id)).json(),
      attribution = Object.fromEntries(
        CATALOG_FIELDS.map((key) => [
          key,
          current.record.attribution[key] ?? null,
        ]),
      );
    Object.assign(attribution, {
      creator_name: "Loïc Norgeot",
      creator_profile_url: "https://sketchfab.com/norgeotloic",
      source_url: extras.source,
      license_name: extras.license,
      credit_text: credit,
      notes:
        "Creator and license copied from original embedded glTF asset metadata; original source array preserved.",
    });
    const body = {
      revision: current.revision,
      attribution,
      note: "",
      folder_path: "terrain/rocks/individual-rocks",
      description: `Unique extracted rock ${part.ordinal}/84 from rocks, source mesh ${part.source_mesh_index} (${part.source_node_name}). Geometry and textures preserved; hierarchy normalized to 1m maximum XZ extent, centered and grounded. Physical pebble size is authored by the component. Source revision ${sourceRevision}.`,
      tags: ["rock", "stone", "pebble", "terrain", "extracted-rock"],
      construction: {
        schema_version: 1,
        kind: "model",
        source_units: "m",
        meters_per_unit: 1,
        dimensions_m: part.dimensions_m,
        up_axis: "y",
        forward_axis: "z",
        ground_anchor_m: [0, 0, 0],
        footprint_m: part.footprint_m,
        texture_size_m: null,
        placement: "ground",
      },
    };
    const updated = await (
      await request("/" + imported.id, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3106",
        },
        body: JSON.stringify(body),
      })
    ).json();
    asset = { id: imported.id, revision: updated.revision };
  }
  report.parts.push({
    ...metadata,
    glb_sha256: createHash("sha256").update(glb).digest("hex"),
    asset,
  });
  await fs.writeFile(
    new URL("manifest.json", directory),
    JSON.stringify(report, null, 2),
  );
  if (part.ordinal % 12 === 0)
    console.log(
      `${publish ? "Published" : "Prepared"} ${part.ordinal}/84 rocks`,
    );
}
const after = await (await request("/rocks")).json();
if (after.revision !== sourceRevision) throw Error("Original array changed");
console.log(
  JSON.stringify({
    parts: report.parts.length,
    published: publish,
    unique_source_meshes: new Set(report.parts.map((p) => p.source_mesh_index))
      .size,
    original_array_unchanged: true,
    manifest: "runtime/rock-extraction/manifest.json",
  }),
);
