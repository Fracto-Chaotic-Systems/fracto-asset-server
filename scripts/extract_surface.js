import { extract_environment_surface } from "../environment/extract_surface.js";
import { environment_catalog_directory } from "../environment/catalog.js";
import { create_environment_asset_registry } from "../environment/registry_client.js";
const registry = create_environment_asset_registry();
try {
  if (process.argv.length !== 3)
    throw new Error("Usage: extract_surface.js <asset-id>");
  const result = await extract_environment_surface({
    directory: environment_catalog_directory(),
    id: process.argv[2],
    registry,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Surface extraction failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await registry.close();
}
