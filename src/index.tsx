import { render } from "ink";
import App from "./app.js";
import { runDaemon, statusDaemon, stopDaemon } from "./daemon.js";

if (process.argv.includes("--daemon")) {
  runDaemon();
} else if (process.argv.includes("--status")) {
  statusDaemon();
} else if (process.argv.includes("--stop")) {
  stopDaemon();
} else {
  render(<App />);
}
