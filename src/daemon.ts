import { appendFileSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CONFIG_DIR } from "./config.js";
import { setLogFn } from "./utils.js";
import { main } from "./main.js";

const LOG_FILE = join(CONFIG_DIR, "bot.log");
const PID_FILE = join(CONFIG_DIR, "bot.pid");
const DAEMON_ENV = "FORTYTWO_DAEMON_CHILD";

function readPid(): number | null {
  try {
    const raw = String(readFileSync(PID_FILE, "utf-8")).trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function statusDaemon(): boolean {
  const pid = readPid();
  if (!pid) {
    console.log("Daemon not running (no PID file).");
    return false;
  }
  if (isRunning(pid)) {
    console.log(`Daemon running (PID ${pid}).`);
    return true;
  }
  console.log(`Daemon not running (stale PID ${pid}).`);
  return false;
}

export function stopDaemon(): boolean {
  const pid = readPid();
  if (!pid) {
    console.log("Daemon not running (no PID file).");
    return false;
  }
  if (!isRunning(pid)) {
    console.log(`Daemon not running (stale PID ${pid}).`);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (PID ${pid}).`);
    return true;
  } catch (err) {
    console.log(`Failed to stop daemon (PID ${pid}): ${err}`);
    return false;
  }
}

function fileLog(msg: string) {
  const ts = new Date().toISOString();
  appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

export async function runDaemon(): Promise<void> {
  if (!process.env[DAEMON_ENV]) {
    const pid = readPid();
    if (pid && isRunning(pid)) {
      console.log(`Daemon already running (PID ${pid}).`);
      return;
    }
    const args = process.argv.slice(1);
    if (!args.includes("--daemon")) args.push("--daemon");
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [DAEMON_ENV]: "1" },
    });
    const started = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 300);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!started || !child.pid) {
      console.log("Failed to start daemon.");
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
    const childPid = readPid();
    if (childPid && isRunning(childPid)) {
      console.log(`Daemon started (PID ${childPid}).`);
    } else {
      console.log("Daemon failed to start (no PID file).");
    }
    child.unref();
    return;
  }

  setLogFn(fileLog);

  writeFileSync(PID_FILE, String(process.pid));

  const cleanup = () => {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`Daemon started (PID ${process.pid})`);
  console.log(`Logs: ${LOG_FILE}`);
  console.log(`Stop: kill $(cat ${PID_FILE})`);

  try {
    await main();
  } finally {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
}
