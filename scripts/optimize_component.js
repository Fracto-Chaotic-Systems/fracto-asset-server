import { optimize_component_release } from "../components/optimize_release.js";

const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
if (
  args.length !== 6 ||
  !["--key", "--release", "--materials"].every((key) => args.includes(key))
)
  throw new Error(
    "Usage: node scripts/optimize_component.js --key grass-strip --release SHA256 --materials animated-grass,yard-grass",
  );
console.log(
  JSON.stringify(
    await optimize_component_release({
      key: value("--key"),
      release: value("--release"),
      material_ids: value("--materials").split(","),
    }),
    null,
    2,
  ),
);
