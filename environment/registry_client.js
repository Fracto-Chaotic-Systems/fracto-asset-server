import { environment_registration } from "@fracto/sdk/FractoEnvironmentCatalog.js";
import { internal_service_headers } from "@fracto/sdk/utils/ServiceAuthorization.js";

// Database connections and SQL belong exclusively to the data service.
export function create_environment_asset_registry({ request = fetch } = {}) {
  return {
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
