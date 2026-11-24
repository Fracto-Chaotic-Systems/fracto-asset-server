import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { component_document_json } from "@fracto/sdk/FractoComponentDocument.js";
import { component_reference_key } from "@fracto/sdk/FractoComponentTools.js";
import {
  COMPONENT_RUNTIME_FILE_LIMIT,
  component_runtime_json,
  runtime_resource_path,
} from "@fracto/sdk/FractoComponentRuntime.js";

export const published_directory = path.join(import.meta.dirname, "published");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function publish_component({
  key,
  component_url,
  catalog_url,
  root = published_directory,
  request = fetch,
}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key || ""))
    throw new Error("invalid_runtime_key");
  const get = async (url) => {
    const response = await request(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok)
      throw new Error(`publication_source_failed_${response.status}`);
    return response;
  };
  const authored = await (await get(component_url)).json();
  const source_document_sha256 = sha(
    component_document_json(authored.document),
  );
  const component = structuredClone(authored.document);
  delete component.construction_description;
  const refs = [
    ...new Map(
      [
        component.floor?.asset,
        ...component.objects.map((o) => o.asset),
        ...component.scatters.map((o) => o.asset),
      ]
        .filter(Boolean)
        .map((ref) => [component_reference_key(ref), ref]),
    ).values(),
  ];
  const parent = path.resolve(root, key);
  await fs.mkdir(parent, { recursive: true });
  const stage = path.join(parent, `.publish-${randomUUID()}`);
  await fs.mkdir(stage);
  const files = [],
    materials = [],
    notices = [];
  const pending_files = new Map();
  const put = async (relative, bytes) => {
    runtime_resource_path(relative);
    if (pending_files.has(relative)) return pending_files.get(relative);
    if (!bytes.length || bytes.length > COMPONENT_RUNTIME_FILE_LIMIT)
      throw new Error("publication_file_too_large");
    const target = path.join(stage, ...relative.split("/"));
    if (!target.startsWith(stage + path.sep))
      throw new Error("invalid_publication_path");
    const pending = (async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx" });
      files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
      return relative;
    })();
    pending_files.set(relative, pending);
    return pending;
  };
  try {
    for (let i = 0; i < refs.length; i += 4) {
      const results = await Promise.allSettled(
        refs.slice(i, i + 4).map(async (ref) => {
          const base =
            catalog_url.replace(/\/$/, "") + "/" + encodeURIComponent(ref.id);
          const descriptor = await (
            await get(base + "/construction/runtime?revision=" + ref.revision)
          ).json();
          if (
            descriptor.material.id !== ref.id ||
            descriptor.material.revision !== ref.revision
          )
            throw new Error("publication_material_changed");
          const { construction } = descriptor.material;
          const runtime =
            construction.kind === "surface"
              ? {
                  id: ref.id,
                  model: null,
                  format: null,
                  resources: [component.floor.texture_file],
                }
              : descriptor.runtime;
          const file_paths = {};
          materials.push({
            material: { id: ref.id, revision: ref.revision, construction },
            runtime,
            file_paths,
          });
          for (const resource of runtime.resources) {
            runtime_resource_path(resource);
            const response = await get(
              base +
                "/files/" +
                resource.split("/").map(encodeURIComponent).join("/"),
            );
            if (
              Number(response.headers.get("content-length")) >
              COMPONENT_RUNTIME_FILE_LIMIT
            )
              throw new Error("publication_file_too_large");
            const chunks = [];
            let bytes = 0;
            for await (const chunk of response.body) {
              bytes += chunk.length;
              if (bytes > COMPONENT_RUNTIME_FILE_LIMIT)
                throw new Error("publication_file_too_large");
              chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks),
              extension = /\.[a-z0-9]{1,8}$/i.test(resource)
                ? path.extname(resource).toLowerCase()
                : ".bin";
            file_paths[resource] = await put(
              `files/${sha(buffer)}${extension}`,
              buffer,
            );
          }
          const metadata = await (await get(base)).json();
          if (metadata.revision !== ref.revision)
            throw new Error("publication_material_changed");
          const attribution = metadata.record.attribution || {};
          const notice = {
            id: ref.id,
            text: [
              ref.id,
              attribution.credit_text,
              attribution.license_name,
              attribution.source_url,
              attribution.modification_conditions,
              attribution.redistribution_conditions,
            ]
              .filter(Boolean)
              .join("\n"),
          };
          notices.push(notice);
          if (
            attribution.license_file &&
            !runtime.resources.includes(attribution.license_file)
          ) {
            const response = await get(
              base +
                "/files/" +
                runtime_resource_path(attribution.license_file)
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/"),
            );
            const text = await response.text();
            if (text.length > 1024 * 1024)
              throw new Error("publication_notice_too_large");
            notice.text += "\n" + text;
          }
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    notices.sort((a, b) => a.id.localeCompare(b.id));
    await put(
      "NOTICE.txt",
      Buffer.from(
        "Published component material notices\n\n" +
          notices.map((n) => n.text).join("\n\n---\n\n") +
          "\n",
      ),
    );
    materials.sort((a, b) =>
      component_reference_key(a.material).localeCompare(
        component_reference_key(b.material),
      ),
    );
    files.sort((a, b) => a.path.localeCompare(b.path));
    const after = await (await get(component_url)).json();
    if (
      after.revision !== authored.revision ||
      sha(component_document_json(after.document)) !== source_document_sha256
    )
      throw new Error("publication_component_changed");
    const manifest = {
      schema_version: 1,
      source_revision: authored.revision,
      source_document_sha256,
      component,
      materials,
      files,
    };
    const json = component_runtime_json(manifest),
      release = sha(json),
      target = path.join(parent, release);
    await fs.writeFile(path.join(stage, "manifest.json"), json + "\n", {
      flag: "wx",
    });
    let existing = false;
    try {
      existing =
        (
          await fs.readFile(path.join(target, "manifest.json"), "utf8")
        ).trim() === json;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing) {
      for (const file of files)
        if (
          sha(await fs.readFile(path.join(target, ...file.path.split("/")))) !==
          file.sha256
        )
          throw new Error("published_release_corrupt");
    } else await fs.rename(stage, target);
    return {
      key,
      release,
      source_revision: authored.revision,
      materials: materials.length,
      files: files.length,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      manifest_path: `${key}/${release}/manifest.json`,
      existing,
    };
  } finally {
    if (
      path.dirname(stage) !== parent ||
      !path.basename(stage).startsWith(".publish-")
    )
      throw new Error("unsafe_publication_cleanup");
    await fs.rm(stage, { recursive: true, force: true });
  }
}
