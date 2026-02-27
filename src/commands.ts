import { get as getConfig, saveConfig, reloadConfig, type UserConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import { setVerbose } from "./utils.js";
import { resetLlmClient } from "./llm.js";

const LLM_RESET_KEYS = new Set([
  "llm_model", "openrouter_api_key", "inference_type",
  "llm_api_base", "llm_timeout", "llm_concurrency",
]);

const MASKED_KEYS = new Set(["openrouter_api_key"]);

const NUMERIC_KEYS = new Set([
  "poll_interval", "llm_concurrency", "llm_timeout", "min_balance",
]);

function mask(key: string, value: string): string {
  if (MASKED_KEYS.has(key) && value.length > 8) {
    return value.slice(0, 4) + "***" + value.slice(-4);
  }
  return value;
}

const CONFIG_KEYS = [
  "agent_name", "display_name", "inference_type", "openrouter_api_key",
  "llm_api_base", "fortytwo_api_base", "identity_file", "poll_interval",
  "llm_model", "llm_concurrency", "llm_timeout", "min_balance",
  "bot_role", "answerer_system_prompt",
];

export const SUGGESTIONS = [
  "/help",
  "/ask ",
  "/identity",
  "/config show",
  ...CONFIG_KEYS.map((k) => `/config set ${k} `),
  "/verbose on",
  "/verbose off",
  "/exit",
];

export function executeCommand(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  // Strip leading /
  const stripped = raw.startsWith("/") ? raw.slice(1) : raw;
  const parts = stripped.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  if (!cmd) return [];

  if (cmd === "help") {
    return [
      "Commands:",
      "  /ask <question>    — submit a question to the network",
      "  /identity          — show agent_id and secret",
      "  /config show       — show all config values",
      "  /config set <k> <v> — change a config value",
      "  /verbose on|off    — toggle verbose logging",
      "  /exit              — quit the application",
    ];
  }

  if (cmd === "exit" || cmd === "quit") {
    process.exit(0);
  }

  if (cmd === "identity") {
    const cfg = getConfig();
    const id = loadIdentity(cfg.identity_file);
    if (!id) return ["No identity found."];
    return [
      "Identity:",
      `  agent_id: ${id.agent_id}`,
      `  secret:   ${id.secret}`,
    ];
  }

  if (cmd === "verbose") {
    const on = parts[1]?.toLowerCase() === "on";
    setVerbose(on);
    return [`Verbose ${on ? "on" : "off"}`];
  }

  if (cmd === "config") {
    const sub = parts[1]?.toLowerCase();
    const cfg = getConfig();

    if (sub === "show") {
      const lines: string[] = ["Config:"];
      for (const [k, v] of Object.entries(cfg)) {
        lines.push(`  ${k}: ${mask(k, String(v))}`);
      }
      return lines;
    }

    if (sub === "set") {
      const key = parts[2];
      if (!key || !(key in cfg)) {
        return [`Unknown key: ${key ?? "(empty)"}. Use "/config show".`];
      }
      const rawValue = parts.slice(3).join(" ");
      if (!rawValue) return [`Usage: /config set <key> <value>`];

      let value: string | number = rawValue;
      if (NUMERIC_KEYS.has(key)) {
        value = Number(rawValue);
        if (isNaN(value)) return [`Invalid number: ${rawValue}`];
      }

      const updated = { ...cfg, [key]: value };
      saveConfig(updated);
      reloadConfig();

      if (LLM_RESET_KEYS.has(key)) resetLlmClient();

      return [`${key} = ${mask(key, String(value))}`];
    }

    return [`Usage: /config show | /config set <key> <value>`];
  }

  return [`Unknown command: ${cmd}. Type "/help".`];
}
