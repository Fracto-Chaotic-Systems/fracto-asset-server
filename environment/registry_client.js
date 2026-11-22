import {
  environment_registration,
  validate_model_category,
  validate_model_asset_page,
} from "@fracto/sdk/FractoEnvironmentCatalog.js";
import { internal_service_headers } from "@fracto/sdk/utils/ServiceAuthorization.js";

// Database connections and SQL belong exclusively to the data service.
export function create_environment_asset_registry({ request = fetch } = {}) {
  return {
    async list(category) {
      if (category !== undefined) validate_model_category(category);
      const assets = [];
      let after = "";
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (category) query.set("category", category);
        if (after) query.set("after", after);
        const response = await request(
          `http://127.0.0.1:${Number(process.env.FRACTO_DATA_PORT || 3002)}/internal/environment-assets?${query}`,
          {
            headers: internal_service_headers(),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) throw new Error("catalog_unavailable");
        const page = validate_model_asset_page(await response.json(), category);
        if (
          page.assets.some(
            (asset, i) => asset.id <= (i ? page.assets[i - 1].id : after),
          ) ||
          (page.next_cursor && page.next_cursor !== page.assets.at(-1)?.id)
        )
          throw new Error("catalog_unavailable");
        assets.push(...page.assets);
        after = page.next_cursor;
      } while (after);
      return assets;
    },
    async sync(record, revision) {
      const port = Number(process.env.FRACTO_DATA_PORT || 3002);
      const response = await request(
        `http://127.0.0.1:${port}/internal/environment-assets/${encodeURIComponent(record.id)}`,
        {
          method: "PUT",
          headers: internal_service_headers({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(environment_registration(record, revision)),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error("catalog_unavailable");
      const saved = await response.json();
      if (saved.id !== record.id || saved.revision !== revision)
        throw new Error("catalog_unavailable");
    },
    async close() {},
  };
}
