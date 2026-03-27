import { readFileSync } from "node:fs";
import { render } from "ink";
import App from "./app.js";
import { startViewerServer } from "./viewer-server.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

if (process.argv.includes("--version")) {
  console.log(pkg.version);
  process.exit(0);
}

const viewer = startViewerServer(4242);

console.clear();
const { unmount } = render(<App />);

const shutdown = () => {
  viewer.close();
  unmount();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
