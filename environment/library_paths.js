import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Imports publish beneath ingredients; existing catalog records may use any tier. */
export async function ingredient_directory(root, { create = false } = {}) {
  const directory = path.join(root, "ingredients");
  try {
    if (create) await mkdir(directory, { recursive: true });
    const resolved = await realpath(directory);
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw Object.assign(new Error("unsafe_path"), { status: 400 });
    }
    return resolved;
  } catch (error) {
    if (!create && error.code === "ENOENT") return directory;
    throw error;
  }
}
