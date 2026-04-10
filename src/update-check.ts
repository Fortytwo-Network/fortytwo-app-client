import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import pkg from "../package.json" with { type: "json" };

export const UPDATE_COMMAND = "npm install -g @fortytwo-network/fortytwo-cli@latest";

const REGISTRY_URL =
  "https://registry.npmjs.org/@fortytwo-network/fortytwo-cli/latest";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT = 5000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

interface CacheData {
  lastCheck: number;
  latestVersion: string;
}

function cachePath(): string {
  return join(getConfigDir(), "update-check.json");
}

function readCache(): CacheData | null {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(data: CacheData): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(data));
  } catch {
    // ignore write errors
  }
}

export function isNewerVersion(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = (await res.json()) as { version: string };
  return data.version;
}

function buildInfo(latestVersion: string): UpdateInfo {
  return {
    currentVersion: pkg.version,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, pkg.version),
  };
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const cache = readCache();
    if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL) {
      return buildInfo(cache.latestVersion);
    }
    const latestVersion = await fetchLatestVersion();
    writeCache({ lastCheck: Date.now(), latestVersion });
    return buildInfo(latestVersion);
  } catch {
    return null;
  }
}

export function getCachedUpdate(): UpdateInfo | null {
  try {
    const cache = readCache();
    if (!cache) return null;
    return buildInfo(cache.latestVersion);
  } catch {
    return null;
  }
}
