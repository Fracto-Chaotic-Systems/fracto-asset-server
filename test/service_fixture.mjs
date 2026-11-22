import express from "express";
import { serve_fixture } from "@fracto/sdk/testing/ServiceFixture.js";
import { InstrumentTransferStore } from "../instruments/transfer_store.js";
import { create_instrument_router } from "../handlers/instruments.js";
import { create_instrument_transfer_router } from "../handlers/instrument_transfer.js";

if (process.argv.includes("--serve-fixture")) {
  const options = JSON.parse(process.env.FRACTO_TEST_FIXTURE_OPTIONS || "{}");
  const app = express();
  let store, router;
  const restart = async () => {
    store = new InstrumentTransferStore({ directory: options.directory, persistent: true, publication_enabled: !!options.publication_enabled, storage: async () => ({ ready: true, free_bytes: 32 * 1024 ** 3 }) });
    if (options.initialize) await store.initialize();
    router = create_instrument_transfer_router({ store, authorize: (req, res, next) => req.get("x-fracto-service-token") === options.internal ? next() : res.sendStatus(403) });
  };
  if (!options.catalog_only) {
    await restart();
    app.use("/internal/instrument-transfer", (req, res, next) => router(req, res, next));
  }
  app.use(options.catalog_prefix || "/instruments", create_instrument_router({ ...(options.directory ? { directory: options.directory } : {}), public_url: "", logger: { error() {} } }));
  await serve_fixture(app, express, options.catalog_only ? {} : {
    restart: async () => { await restart(); },
    state: () => ({ sessions: [...store.sessions.values()].map(({ id, state, error, expires_at }) => ({ id, state, error, expires_at })), exports: [...store.exports.keys()].map(id => ({ id })), reservation: store.reservation ? { active: true } : null }),
    get: ({ id, owner }) => { store.get(store.sessions, id, owner); return {}; },
    lookup: async ({ id, owner }) => store.status(await store.lookup(store.sessions, id, owner)),
  });
}
