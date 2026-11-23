import {
  CATALOG_FIELDS,
  normalize_model_folder,
} from "@fracto/sdk/FractoEnvironmentCatalog.js";
import {
  folder_contains,
  validate_model_management,
} from "@fracto/sdk/FractoModelManagement.js";

const fail = (code) => {
  throw Object.assign(new Error(code), { status: 409 });
};
const edit = (catalog, changes) => ({
  revision: catalog.revision,
  attribution: Object.fromEntries(
    CATALOG_FIELDS.map((key) => [key, catalog.record.attribution[key]]),
  ),
  note: "",
  ...changes,
});

/** Serialize tree operations; every model update still checks its file revision. */
export function create_model_management(store) {
  let queue = Promise.resolve();
  const perform = async (input) => {
    const body = validate_model_management(input);
    if (body.action.endsWith("-model")) {
      const original = await store.get(body.id);
      if (original.revision !== body.revision) fail("file_conflict");
      await store.update(
        body.id,
        edit(
          original,
          body.action === "rename-model"
            ? { name: body.name }
            : { archived: true },
        ),
      );
      return { id: body.id };
    }
    // Reconcile portable catalogs before checking membership or deleting a folder.
    const { assets } = await store.list(body.category);
    const { folders } = await store.folders(body.category);
    const paths = [
      ...new Set([
        ...folders,
        ...assets.map((asset) => asset.folder_path).filter(Boolean),
      ]),
    ];
    if (!paths.some((path) => folder_contains(body.folder_path, path)))
      fail("folder_not_found");
    const contained = assets.filter((asset) =>
      folder_contains(body.folder_path, asset.folder_path),
    );
    if (body.action === "delete-folder") {
      if (
        contained.length ||
        paths.some(
          (path) =>
            path !== body.folder_path &&
            folder_contains(body.folder_path, path),
        )
      )
        fail("folder_not_empty");
      return store.manage_folder(body);
    }
    if (body.target === body.folder_path)
      return { folder_path: body.folder_path, target: body.target };
    if (paths.some((path) => folder_contains(body.target, path)))
      fail("folder_conflict");
    // Validate every descendant before writing anything (including depth/length).
    for (const path of paths.filter((path) =>
      folder_contains(body.folder_path, path),
    ))
      normalize_model_folder(body.target + path.slice(body.folder_path.length));
    const prepared = await Promise.all(
      contained.map(async (asset) => ({
        id: asset.id,
        original: await store.get(asset.id).then((catalog) => {
          if (catalog.record.folder_path !== asset.folder_path)
            fail("folder_conflict");
          return catalog;
        }),
        target: normalize_model_folder(
          body.target + asset.folder_path.slice(body.folder_path.length),
        ),
      })),
    );
    await store.folders(body.category, body.folder_path);
    const completed = [];
    try {
      for (const item of prepared) {
        try {
          const saved = await store.update(
            item.id,
            edit(item.original, { folder_path: item.target }),
          );
          completed.push({ ...item, saved });
        } catch (error) {
          if (error.published)
            completed.push({ ...item, saved: error.published });
          throw error;
        }
      }
      const { target, ...request } = body;
      void target;
      return await store.manage_folder(request);
    } catch (error) {
      // Compensate successful writes without ever overwriting a newer external edit.
      // A failed registry projection is repaired by the next read/list.
      let conflict = false;
      for (const item of completed.reverse()) {
        try {
          await store.update(
            item.id,
            edit(item.saved, { folder_path: item.original.record.folder_path }),
            { sync_read: false },
          );
        } catch (error) {
          if (!error.published) conflict = true;
        }
      }
      if (conflict) fail("folder_conflict");
      throw error;
    }
  };
  return (input) => {
    const task = queue.catch(() => {}).then(() => perform(input));
    queue = task;
    return task;
  };
}
