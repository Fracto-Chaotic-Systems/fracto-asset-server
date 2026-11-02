import express from "express";
import { fileURLToPath } from "node:url";
import {
  create_instrument_library,
  public_catalog,
  content_hash,
  valid_id,
} from "../instruments/http-library.js";

export function create_instrument_router({
  directory = process.env.FRACTO_INSTRUMENT_DIR ||
    fileURLToPath(new URL("../instruments/", import.meta.url)),
  public_url = process.env.FRACTO_ASSET_PUBLIC_URL || "",
  logger = console,
} = {}) {
  const router = express.Router(),
    library = create_instrument_library(directory);
  let prefix = "";
  if (public_url) {
    const url = new URL(public_url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "FRACTO_ASSET_PUBLIC_URL must be an HTTP(S) base URL without credentials, query or fragment",
      );
    prefix = url.href.replace(/\/+$/, "");
  }
  const url_for = (id, asset) =>
    `${prefix}/instruments/${id}/audio/${asset.id}?v=${asset.sha256}`;
  const error_response = (res, status, message) => {
    res.removeHeader("Content-Length");
    res.removeHeader("Content-Range");
    res.removeHeader("ETag");
    res.removeHeader("Content-Type");
    res.removeHeader("Accept-Ranges");
    return res
      .status(status)
      .set("Cache-Control", "no-store")
      .json({ error: message });
  };
  router.get("/", async (req, res) => {
    try {
      const snapshot = await library.load();
      const entries = [...snapshot.assets];
      const states = await Promise.all(
        entries.map(async ([id, asset]) =>
          (await library.locate(asset)) ? id : null,
        ),
      );
      const body = Buffer.from(
        JSON.stringify(
          public_catalog(snapshot, new Set(states.filter(Boolean)), url_for),
        ),
      );
      res
        .set("Cache-Control", "private, no-cache")
        .set("ETag", `"${content_hash(body)}"`);
      res.type("application/json").send(body);
    } catch (error) {
      logger.error(
        "[instruments] Catalog unavailable:",
        error.code || error.message,
      );
      error_response(res, 503, "Instrument catalog is unavailable");
    }
  });
  router.get("/:id/audio/:asset", async (req, res) => {
    if (!valid_id(req.params.id) || !valid_id(req.params.asset))
      return error_response(res, 404, "Instrument audio is not registered");
    try {
      const snapshot = await library.load();
      const asset = snapshot.assets.get(`${req.params.id}/${req.params.asset}`);
      if (
        !asset ||
        (req.query.v !== undefined && req.query.v !== asset.entry.sha256)
      )
        return error_response(
          res,
          404,
          "Instrument audio version is not registered",
        );
      const location = await library.locate(asset);
      if (!location)
        return error_response(res, 404, "Instrument audio is unavailable");
      const range = req.headers.range;
      if (
        range &&
        (!/^bytes=(\d*)-(\d*)$/.test(range) ||
          req.range(location.size)?.length !== 1)
      ) {
        res.set("Content-Range", `bytes */${location.size}`);
        return res.status(416).set("Cache-Control", "no-store").end();
      }
      await library.verify_audio(asset, location);
      res.set(
        "Content-Type",
        asset.kind === "original" ? "audio/mpeg" : "audio/wav",
      );
      res.set("X-Content-Type-Options", "nosniff");
      res.set("ETag", `"${asset.entry.sha256}"`);
      res.set(
        "Cache-Control",
        req.query.v
          ? "private, max-age=31536000, immutable"
          : "private, no-cache",
      );
      res.sendFile(
        location.filename,
        {
          etag: false,
          lastModified: false,
          cacheControl: false,
          acceptRanges: true,
          dotfiles: "deny",
        },
        (error) => {
          if (!error || error.code === "ECONNABORTED") return;
          if (res.headersSent) return res.destroy();
          error_response(
            res,
            error.status === 404 ? 404 : 503,
            "Instrument audio is unavailable",
          );
        },
      );
    } catch (error) {
      logger.error(
        "[instruments] Audio unavailable:",
        error.code || error.message,
      );
      if (!res.headersSent)
        error_response(res, 503, "Instrument audio is unavailable");
      else res.destroy();
    }
  });
  router.use((error, req, res, next) => {
    if (error instanceof URIError)
      return error_response(res, 400, "Invalid instrument route");
    next(error);
  });
  return router;
}
