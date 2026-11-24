import express from 'express'
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { require_enabled_user_if_configured } from "@fracto/sdk/utils/ServiceAuthorization.js";

const SEPARATOR = path.sep;

const FRACTO_ASSET_PORT = Number(process.env.FRACTO_ASSET_PORT || 3003);

import {handle_main_status} from "./handlers/status.js";
import {handle_logs} from "./handlers/logs.js";
import {handle_render_image} from "./handlers/render_image.js";
import { initialize_asset_tables } from "./handlers/initialize_videos.js";
import { handle_new_video } from "./handlers/new_video.js";
import { handle_update_video } from "./handlers/update_video.js";
import {
   handle_render_status,
   handle_render_create,
   handle_render_cancel,
   handle_render_retry,
   handle_render_assemble,
   handle_render_output,
} from "./handlers/render_video.js";

import { asset_cors } from "./middleware/cors.js";
import { create_environment_catalog_router } from "./environment/routes.js";
import { create_component_runtime_router } from "./components/routes.js";
import { create_instrument_router } from "./handlers/instruments.js";
import { create_instrument_transfer_router } from "./handlers/instrument_transfer.js";
import { initialize_instrument_storage } from "./instruments/transfer_storage_init.js";

await initialize_instrument_storage();
const app = express();

app.use(asset_cors);
app.use('/component-runtime', create_component_runtime_router());
// Owns folder imports, Blender conversion, catalog files and preview resources.
app.use('/environment-catalog', create_environment_catalog_router());

// Private inventory/preview authenticates before its bounded body parser.
app.use('/internal/instrument-transfer', create_instrument_transfer_router());

app.use(express.json());

if (!fs.existsSync(`.${SEPARATOR}images`)) {
   console.log(chalk.cyan(`creating images directory`))
   fs.mkdirSync(`.${SEPARATOR}images`)
}

await initialize_asset_tables();

// Start the server and listen for incoming requests
app.listen(FRACTO_ASSET_PORT, () => {
   console.log(chalk.green(`fracto-asset-server is running on http://localhost:${FRACTO_ASSET_PORT}`));
});

app.get('/', handle_main_status)
app.use((req, res, next) => req.path === '/' ? next() : require_enabled_user_if_configured(req, res, next))
app.use("/instruments", create_instrument_router());
app.get('/logs', handle_logs)
app.get('/render_image', handle_render_image)
app.post('/new_video', handle_new_video)
app.put('/video/:id', handle_update_video)
app.get('/video/:id/render', handle_render_status)
app.post('/video/:id/render', handle_render_create)
app.post('/video/:id/render/cancel', handle_render_cancel)
app.post('/video/:id/render/retry', handle_render_retry)
app.post('/video/:id/render/assemble', handle_render_assemble)
app.get('/video/:id/render/output', handle_render_output)
