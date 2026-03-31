import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".fortytwo");

export type InferenceType = "openrouter" | "self-hosted";

export interface UserConfig {
  node_name: string;
  node_display_name: string;
  inference_type: InferenceType;
  openrouter_api_key: string;
  self_hosted_api_base: string;
  fortytwo_api_base: string;
  node_identity_file: string;
  poll_interval: number;
  model_name: string;
  llm_concurrency: number;
  llm_timeout: number;
  min_balance: number;
  node_role: string;
  answerer_system_prompt: string;
}

export const DEFAULTS: UserConfig = {
  node_name: "",
  node_display_name: "",
  inference_type: "openrouter",
  openrouter_api_key: "",
  self_hosted_api_base: "",
  fortytwo_api_base: "https://app.fortytwo.network/api",
  node_identity_file: join(CONFIG_DIR, "identity.json"),
  poll_interval: 120,
  model_name: "qwen/qwen3.5-35b-a3b",
  llm_concurrency: 40,
  llm_timeout: 120,
  min_balance: 5.0,
  node_role: "JUDGE",
  answerer_system_prompt: "You are a helpful assistant.",
};

let _configDir: string = CONFIG_DIR;

export function setConfigDir(dir: string): void {
  _configDir = dir;
}

export function getConfigDir(): string {
  return _configDir;
}

export function getConfigPath(): string {
  return join(_configDir, "config.json");
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

/**
 * Migrate renamed config fields. Add new entries to FIELD_RENAMES
 * whenever a config key is renamed — old configs will auto-migrate.
 */
const FIELD_RENAMES: Record<string, string> = {
  bot_role: "node_role",
  agent_name: "node_name",
  display_name: "node_display_name",
  identity_file: "node_identity_file",
  llm_model: "model_name",
  llm_api_base: "self_hosted_api_base",
};

function migrateFields(raw: Record<string, unknown>): Record<string, unknown> {
  for (const [oldKey, newKey] of Object.entries(FIELD_RENAMES)) {
    if (oldKey in raw && !(newKey in raw)) {
      raw[newKey] = raw[oldKey];
      delete raw[oldKey];
    }
  }
  if (raw.inference_type === "local") {
    raw.inference_type = "self-hosted";
  }
  return raw;
}

export function loadConfig(): UserConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = migrateFields(JSON.parse(readFileSync(path, "utf-8")));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: UserConfig): void {
  mkdirSync(_configDir, { recursive: true });
  writeFileSync(join(_configDir, "config.json"), JSON.stringify(cfg, null, 2));
}

// Live config — loaded once, modules import these
let _cfg = loadConfig();

export function reloadConfig(): void {
  _cfg = loadConfig();
}

export const get = () => _cfg;

// Bradley-Terry parameters (hardcoded, not user-configurable)
export const BT_MAX_ITERATIONS = 1000;
export const BT_CONVERGENCE_THRESHOLD = 1e-6;
export const MIN_DEADLINE_SECONDS = 300;
