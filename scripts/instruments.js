import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { seed_library, verify_library } from "../instruments/library.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "source-repo": { type: "string" },
    "library-dir": { type: "string" },
    "sources-only": { type: "boolean", default: false },
  },
});
const directory = path.resolve(
  values["library-dir"] ??
    fileURLToPath(new URL("../instruments/", import.meta.url)),
);
try {
  if (positionals.length !== 1 || !["seed", "verify"].includes(positionals[0]))
    throw new Error(
      "Usage: node scripts/instruments.js seed --source-repo PATH | verify [--library-dir PATH]",
    );
  const result =
    positionals[0] === "seed"
      ? seed_library({ source_repo: values["source-repo"], directory })
      : verify_library(directory, {
          include_playback: !values["sources-only"],
        });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
