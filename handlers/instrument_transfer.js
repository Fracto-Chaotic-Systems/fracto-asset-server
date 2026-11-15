import express from "express";
import { fileURLToPath } from "node:url";
import { require_internal_service } from "../../../utils/service_authorization.js";
import { InstrumentTransferStore } from "../instruments/transfer_store.js";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  binary_length,
  transfer_deadline,
} from "../../../utils/instrument_transfer_stream.js";
import {
  exact_fields,
  is_hash,
  version_body,
  transfer_error,
  public_transfer_error,
  TRANSFER_LIMITS,
} from "../../../utils/instrument_transfer.js";

export function create_instrument_transfer_router({
  store = new InstrumentTransferStore({
    directory:
      process.env.FRACTO_INSTRUMENT_DIR ||
      fileURLToPath(new URL("../instruments/", import.meta.url)),
    persistent:
      Boolean(process.env.FRACTO_INSTRUMENT_DIR) &&
      process.env.FRACTO_INSTRUMENT_TRANSFER_PERSISTENT === "true",
  }),
  authorize = require_internal_service,
} = {}) {
  const router = express.Router();
  router.use(authorize, async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      if (!is_hash(req.get("x-fracto-transfer-owner")))
        return res.status(400).json({
          error: public_transfer_error(transfer_error("invalid_request", 400)),
        });
      req.transfer_owner = req.get("x-fracto-transfer-owner");
      await store.initialize?.();
      next();
    } catch (error) {
      next(error);
    }
  });
  const control = express.json({
    limit: TRANSFER_LIMITS.control_bytes,
    inflate: false,
  });
  const safe = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };
  router.get(
    "/capabilities",
    safe(async (_req, res) => res.json(await store.capabilities())),
  );
  router.post(
    "/exports/:id/reserve",
    control,
    safe(async (req, res) => {
      const entry = store.get(store.exports, req.params.id, req.transfer_owner);
      res
        .status(202)
        .json(store.status(store.reserve_export(entry, req.body), true));
    }),
  );
  router.get(
    "/exports/:id/files/:file_id",
    safe(async (req, res) => {
      const entry = store.get(store.exports, req.params.id, req.transfer_owner);
      if (entry.state !== "reserved") throw transfer_error("invalid_state");
      const file = store.file(entry, req.params.file_id);
      const source = store.send(entry, file.file_id),
        deadline = transfer_deadline(entry.signal);
      try {
        res.set({
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.bytes),
          ETag: `"${file.sha256}"`,
        });
        const progress = new Transform({
          transform(chunk, _encoding, callback) {
            deadline.touch();
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.from(source.chunks, {
            objectMode: false,
            highWaterMark: 64 * 1024,
          }),
          progress,
          res,
          { signal: deadline.signal },
        );
      } finally {
        deadline.close();
        await source.close();
      }
    }),
  );
  router.post(
    "/exports",
    control,
    safe(async (req, res) => {
      version_body(req.body);
      const entry = store.start_export(req.transfer_owner);
      res.status(202).json({ protocol_version: 1, export_id: entry.id });
    }),
  );
  router.get(
    "/exports/:id",
    safe(async (req, res) =>
      res.json(
        store.status(
          store.get(store.exports, req.params.id, req.transfer_owner),
          true,
        ),
      ),
    ),
  );
  for (const item of ["manifest", "catalog"])
    router.get(
      `/exports/:id/${item}`,
      safe(async (req, res) => {
        const entry = store.get(
          store.exports,
          req.params.id,
          req.transfer_owner,
        );
        if (entry.state !== "ready") throw transfer_error("invalid_state");
        if (item === "manifest") res.json(entry.package.manifest);
        else res.type("application/json").send(entry.package.catalog_text);
      }),
    );
  router.post(
    "/exports/:id/release",
    control,
    safe(async (req, res) => {
      version_body(req.body);
      await store.cancel(store.exports, req.params.id, req.transfer_owner);
      store.exports.delete(req.params.id);
      res.json({ protocol_version: 1 });
    }),
  );
  router.post(
    "/sessions",
    express.json({
      limit: TRANSFER_LIMITS.preview_request_bytes,
      inflate: false,
    }),
    safe(async (req, res) => {
      exact_fields(req.body, [
        "protocol_version",
        "manifest",
        "catalog_text",
        ...(Object.hasOwn(req.body ?? {}, "replacement_policy")
          ? ["replacement_policy"]
          : []),
      ]);
      if (req.body.protocol_version !== 1)
        throw transfer_error("upgrade_required");
      const entry = store.start_session(
        req.transfer_owner,
        req.body.manifest,
        req.body.catalog_text,
        req.body.replacement_policy,
      );
      res.status(202).json({ protocol_version: 1, session_id: entry.id });
    }),
  );
  router.get(
    "/sessions/:id",
    safe(async (req, res) =>
      res.json(
        store.status(
          await store.lookup(store.sessions, req.params.id, req.transfer_owner),
        ),
      ),
    ),
  );
  router.post(
    "/sessions/:id/prepare",
    control,
    safe(async (req, res) => {
      const entry = await store.lookup(
        store.sessions,
        req.params.id,
        req.transfer_owner,
      );
      res.status(202).json(store.status(store.prepare(entry, req.body)));
    }),
  );
  router.put(
    "/sessions/:id/files/:file_id",
    safe(async (req, res) => {
      const entry = await store.lookup(
        store.sessions,
        req.params.id,
        req.transfer_owner,
      );
      const length = binary_length(req.headers);
      res.json(await store.receive(entry, req.params.file_id, req, length));
    }),
  );
  router.post(
    "/sessions/:id/stage",
    control,
    safe(async (req, res) => {
      const entry = await store.lookup(
        store.sessions,
        req.params.id,
        req.transfer_owner,
      );
      res.status(202).json(store.status(store.finish_staging(entry, req.body)));
    }),
  );
  router.post(
    "/sessions/:id/finalize",
    control,
    safe(async (req, res) => {
      const entry = await store.lookup(
        store.sessions,
        req.params.id,
        req.transfer_owner,
      );
      res.status(202).json(store.status(store.finalize(entry, req.body)));
    }),
  );
  router.post(
    "/sessions/:id/cancel",
    control,
    safe(async (req, res) => {
      version_body(req.body);
      res
        .status(202)
        .json(
          store.status(
            await store.cancel(
              store.sessions,
              req.params.id,
              req.transfer_owner,
            ),
          ),
        );
    }),
  );
  router.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const normalized =
      error.type === "entity.too.large"
        ? transfer_error("limit_exceeded", 413)
        : error.type?.startsWith("entity.") || error.status === 415
          ? transfer_error("invalid_request", 400)
          : error;
    res
      .status(normalized.status || 422)
      .json({ error: public_transfer_error(normalized) });
  });
  return router;
}
