import express from 'express'
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { require_enabled_user_if_configured } from "../../utils/service_authorization.js";

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

const app = express();

app.use((req, res, next) => {
   const origin = req.headers.origin;
   const ui_origin = process.env.FRACTO_UI_ORIGIN || `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`;
   const credentialed = Boolean(origin && (origin === ui_origin || process.env.FRACTO_ALLOW_CORS_ALL === 'true'));
   res.setHeader('Access-Control-Allow-Origin', credentialed ? origin : '*');
   res.vary('Origin');
   if (credentialed) res.setHeader('Access-Control-Allow-Credentials', 'true');
   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); // Specify allowed methods
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-Fracto-Service-Token');
   if (req.method === 'OPTIONS') return res.status(204).end();
   next();
});

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
