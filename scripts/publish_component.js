import { publish_component } from "../components/publish.js";
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--key", "--component-url", "--catalog-url"].includes(args[i]) ||
    !args[i + 1]
  )
    throw new Error(
      "Usage: node scripts/publish_component.js --key NAME --component-url URL --catalog-url URL",
    );
  options[args[i].slice(2).replaceAll("-", "_")] = args[i + 1];
}
console.log(JSON.stringify(await publish_component(options), null, 2));
