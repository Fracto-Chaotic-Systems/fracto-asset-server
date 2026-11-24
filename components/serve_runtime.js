import express from "express";
import { create_component_runtime_router } from "./routes.js";

// Optional file-only deployment/verification process. Deliberately does not
// import the combined asset server startup, authoring registry or database.
const port = Number(process.env.FRACTO_RUNTIME_PORT || 3008);
const host = process.env.FRACTO_RUNTIME_HOST || "127.0.0.1";
const app = express();
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
});
app.use("/component-runtime", create_component_runtime_router());
const server = app.listen(port, host, () =>
  console.log(
    JSON.stringify({
      port: server.address().port,
      pid: process.pid,
      mode: "published-files-only",
    }),
  ),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
