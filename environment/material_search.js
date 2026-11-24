import { createHash } from "node:crypto";
import { material_view } from "@fracto/sdk/FractoMaterialMetadata.js";
import {
  validate_material_query,
  search_materials,
} from "@fracto/sdk/FractoMaterialSearch.js";

export const MATERIAL_CATALOG_LIMIT = 2000;
export function create_material_search({ index, read, registry }) {
  let pending = null;
  const snapshot_of_catalog = async () => {
    const signal = AbortSignal.timeout(15000);
    const entries = await index();
    if (
      !Array.isArray(entries) ||
      entries.length > MATERIAL_CATALOG_LIMIT ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    )
      throw new Error("catalog_unavailable");
    const records = [];
    // Bound concurrent file reads and registry reconciliations. Include other
    // categories so archives/category changes cannot leave stale membership.
    for (let offset = 0; offset < entries.length; offset += 4) {
      signal.throwIfAborted();
      records.push(
        ...(await Promise.all(
          entries
            .slice(offset, offset + 4)
            .map(({ id }) => read(id, true, true, signal)),
        )),
      );
    }
    const membership = registry
      ? await registry.list("material", {
          max_assets: MATERIAL_CATALOG_LIMIT,
          signal,
        })
      : records
          .filter(
            ({ record }) =>
              !record.archived && record.model_category === "material",
          )
          .map(({ record }) => ({ id: record.id }));
    const by_id = new Map(records.map((entry) => [entry.record.id, entry]));
    const materials = membership
      .map(({ id }) => {
        const entry = by_id.get(id);
        if (
          !entry ||
          entry.record.archived ||
          entry.record.model_category !== "material"
        )
          throw new Error("catalog_unavailable");
        try {
          return material_view(
            entry.record,
            createHash("sha256").update(entry.raw).digest("hex"),
          );
        } catch {
          throw new Error("catalog_unavailable");
        }
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const snapshot = createHash("sha256")
      .update(
        JSON.stringify(materials.map(({ id, revision }) => [id, revision])),
      )
      .digest("hex");
    signal.throwIfAborted();
    return { materials, snapshot };
  };
  return async (query) => {
    const validated = validate_material_query(query);
    if (!pending)
      pending = snapshot_of_catalog().finally(() => {
        pending = null;
      });
    const { materials, snapshot } = await pending;
    return search_materials(materials, validated, snapshot);
  };
}
