import { readFileSync } from "node:fs";
import { render } from "ink";
import App from "./app.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

if (process.argv.includes("--version")) {
  console.log(pkg.version);
  process.exit(0);
}

render(<App />);
