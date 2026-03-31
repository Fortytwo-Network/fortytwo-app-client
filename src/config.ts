import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".fortytwo");

export type InferenceType = "openrouter" | "local";

export interface UserConfig {
  agent_name: string;
  display_name: string;
  inference_type: InferenceType;
  openrouter_api_key: string;
  llm_api_base: string;
  fortytwo_api_base: string;
  identity_file: string;
  poll_interval: number;
  llm_model: string;
  llm_concurrency: number;
  llm_timeout: number;
  min_balance: number;
  bot_role: string;
  answerer_system_prompt: string;
}

export const DEFAULTS: UserConfig = {
  agent_name: "",
  display_name: "",
  inference_type: "openrouter",
  openrouter_api_key: "",
  llm_api_base: "",
  fortytwo_api_base: "https://app.fortytwo.network/api",
  identity_file: join(CONFIG_DIR, "identity.json"),
  poll_interval: 120,
  llm_model: "qwen/qwen3.5-35b-a3b",
  llm_concurrency: 40,
  llm_timeout: 120,
  min_balance: 5.0,
  bot_role: "JUDGE",
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

export function loadConfig(): UserConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
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
