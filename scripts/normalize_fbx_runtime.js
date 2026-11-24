import { normalize_environment_fbx } from "../environment/normalize_fbx.js";
import { environment_catalog_directory } from "../environment/catalog.js";
import { create_environment_asset_registry } from "../environment/registry_client.js";
const registry = create_environment_asset_registry();
try {
  if (process.argv.length !== 3)
    throw new Error("Usage: normalize_fbx_runtime.js <asset-id>");
  console.log(
    JSON.stringify(
      await normalize_environment_fbx({
        directory: environment_catalog_directory(),
        id: process.argv[2],
        registry,
      }),
    ),
  );
} catch (error) {
  console.error(`Runtime normalization failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await registry.close();
}
