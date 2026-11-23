import { repair_environment_archives } from "../environment/repair_archives.js";
import { environment_catalog_directory } from "../environment/catalog.js";
import { create_environment_asset_registry } from "../environment/registry_client.js";
const registry = create_environment_asset_registry();
try {
  if (process.argv.length !== 3)
    throw new Error("Usage: environment:repair-archives <asset-id>");
  const result = await repair_environment_archives({
    directory: environment_catalog_directory(),
    id: process.argv[2],
    registry,
  });
  console.log(
    `Repaired ${result.id}: ${result.added.length} archive resources registered.`,
  );
} catch (error) {
  console.error(`Archive repair failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await registry.close();
}
