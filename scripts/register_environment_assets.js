import { create_environment_asset_registry } from "../environment/registry_client.js";
import { create_environment_catalog } from "../environment/catalog.js";

const registry = create_environment_asset_registry();
try {
  const { assets } = await create_environment_catalog({ registry }).list();
  console.log(
    `Registered ${assets.length} environment assets in the database.`,
  );
} finally {
  await registry.close();
}
