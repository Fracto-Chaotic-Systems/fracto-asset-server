import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  component_runtime_json,
  COMPONENT_RUNTIME_MANIFEST_LIMIT,
} from "@fracto/sdk/FractoComponentRuntime.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unchanged = (req, res, hash) => {
  const tag = `"${hash}"`;
  res.set("ETag", tag);
  const tags = String(req.headers["if-none-match"] || "")
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""));
  if (tags.includes("*") || tags.includes(tag)) {
    res.status(304).end();
    return true;
  }
  return false;
};
// Published files only. No authoring catalog, registry or database dependency.
export function create_component_runtime_router({
  root = path.join(import.meta.dirname, "published"),
} = {}) {
  const router = express.Router(),
    cache = new Map();
  const load = async (key, release) => {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) ||
      !/^[a-f0-9]{64}$/.test(release)
    )
      throw new Error("not_found");
    const id = key + "/" + release;
    if (cache.has(id)) return cache.get(id);
    const directory = await fs.realpath(path.join(root, key, release));
    const allowed = await fs.realpath(root);
    if (!directory.startsWith(allowed + path.sep)) throw new Error("not_found");
    const manifest_file = path.join(directory, "manifest.json");
    if ((await fs.stat(manifest_file)).size > COMPONENT_RUNTIME_MANIFEST_LIMIT)
      throw new Error("corrupt");
    const manifest = JSON.parse(await fs.readFile(manifest_file, "utf8"));
    const canonical = component_runtime_json(manifest);
    if (sha(canonical) !== release) throw new Error("corrupt");
    const files = new Map();
    for (const file of manifest.files)
      files.set(file.path, { ...file, verified: null });
    const result = { manifest, canonical, files, directory };
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(id, result);
    return result;
  };
  router.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method))
      return res.status(405).set("Allow", "GET, HEAD").end();
    next();
  });
  router.get("/:key/:release/*file", async (req, res) => {
    try {
      const publication = await load(req.params.key, req.params.release),
        relative = req.params.file.join("/");
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Security-Policy", "sandbox; default-src 'none'");
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      if (relative === "manifest.json") {
        if (unchanged(req, res, req.params.release)) return;
        return res.type("json").send(publication.canonical);
      }
      const file = publication.files.get(relative);
      if (!file)
        return res
          .status(404)
          .set("Cache-Control", "no-store")
          .json({ error: "runtime_file_not_found" });
      // Validate a requested file once, not every dependency before returning
      // the small manifest. Concurrent requests share the same verification.
      file.verified ??= (async () => {
        const full = await fs.realpath(
          path.join(publication.directory, ...file.path.split("/")),
        );
        if (
          !full.startsWith(publication.directory + path.sep) ||
          (await fs.stat(full)).size !== file.bytes ||
          sha(await fs.readFile(full)) !== file.sha256
        )
          throw new Error("corrupt");
        return full;
      })();
      const full = await file.verified;
      if (unchanged(req, res, file.sha256)) return;
      res.sendFile(full, { lastModified: false, etag: false }, (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
    } catch (error) {
      const status =
        error.code === "ENOENT" || error.message === "not_found" ? 404 : 503;
      res
        .status(status)
        .set("Cache-Control", "no-store")
        .json({
          error:
            status === 404
              ? "runtime_release_not_found"
              : "runtime_release_unavailable",
        });
    }
  });
  return router;
}
