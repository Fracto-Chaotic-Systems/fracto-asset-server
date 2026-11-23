import { inspect_environment_import } from "./prepare_import.js";
import { create_model_management } from "./management.js";
import express from "express";
import {
  create_environment_catalog,
  environment_catalog_directory,
} from "./catalog.js";
import { import_environment_asset } from "./import.js";
import { require_enabled_user_if_configured } from "@fracto/sdk/utils/ServiceAuthorization.js";
import { trusted_mutation_origin } from "@fracto/sdk/utils/AuthRequestOrigin.js";
import { create_environment_asset_registry } from "./registry_client.js";

export function create_environment_catalog_router({
  store = create_environment_catalog({
    registry: create_environment_asset_registry(),
  }),
  authorize = require_enabled_user_if_configured,
  inspector = inspect_environment_import,
  importer = (body) =>
    import_environment_asset(environment_catalog_directory(), body),
} = {}) {
  const router = express.Router();
  const manage = create_model_management(store);
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!trusted_mutation_origin(req, res)) return;
    authorize(req, res, next);
  });
  const respond = (operation) => async (req, res) => {
    try {
      res.json(await operation(req));
    } catch (error) {
      const known = [
        "folder_not_empty",
        "folder_not_found",
        "folder_conflict",
        "invalid_asset",
        "invalid_record",
        "invalid_folder",
        "invalid_url",
        "file_conflict",
        "asset_not_found",
        "catalog_path",
        "unsafe_path",
        "duplicate_path",
        "import_too_large",
        "archive_depth",
        "no_model",
        "invalid_import",
        "invalid_archive",
        "import_busy",
        "blender_unavailable",
        "blender_missing_textures",
        "blender_no_mesh",
        "blender_conversion_failed",
      ];
      res
        .status(known.includes(error.message) ? error.status || 400 : 503)
        .json({
          error: known.includes(error.message)
            ? error.message
            : "catalog_unavailable",
        });
    }
  };
  router.get(
    "/",
    respond((req) => store.list(req.query.category)),
  );
  router.post(
    "/import/inspect",
    express.raw({ type: "application/zip", limit: "128mb" }),
    respond((req) => {
      if (!Buffer.isBuffer(req.body))
        throw Object.assign(new Error("invalid_import"), { status: 400 });
      return inspector(req.body);
    }),
  );
  router.post(
    "/import",
    express.raw({ type: "application/zip", limit: "128mb" }),
    respond(async (req) => {
      if (!Buffer.isBuffer(req.body))
        throw Object.assign(new Error("invalid_import"), { status: 400 });
      const result = await importer(req.body);
      await store.get(result.id);
      return result;
    }),
  );
  router.get("/:id/files/*file", async (req, res) => {
    try {
      res.set("Content-Security-Policy", "sandbox; default-src 'none'");
      res.set("X-Content-Type-Options", "nosniff");
      res.sendFile(await store.file(req.params.id, req.params.file.join("/")));
    } catch {
      res.status(404).json({ error: "asset_not_found" });
    }
  });
  router.use(express.json({ limit: "128kb", strict: true }));
  router.post(
    "/manage",
    respond((req) => manage(req.body)),
  );
  router.get(
    "/folders",
    respond((req) => store.folders(req.query.category)),
  );
  router.post(
    "/folders",
    respond((req) => {
      if (
        !req.body ||
        Object.keys(req.body).some(
          (key) => !["category", "folder_path"].includes(key),
        )
      )
        throw new Error("invalid_record");
      return store.folders(req.body.category, req.body.folder_path ?? "");
    }),
  );
  router.get(
    "/:id",
    respond((req) => store.get(req.params.id)),
  );
  router.patch(
    "/:id",
    respond((req) => store.update(req.params.id, req.body)),
  );
  router.use((error, req, res, next) => {
    if (!error) return next();
    res
      .status(error.type === "entity.too.large" ? 413 : 400)
      .json({ error: "invalid_record" });
  });
  return router;
}
