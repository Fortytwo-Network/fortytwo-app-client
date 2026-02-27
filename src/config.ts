import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".fortytwo");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

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

const DEFAULTS: UserConfig = {
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

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): UserConfig {
  if (!configExists()) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: UserConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
