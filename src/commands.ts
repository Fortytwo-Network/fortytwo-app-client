import { get as getConfig, saveConfig, reloadConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import { setVerbose } from "./utils.js";
import { resetLlmClient } from "./llm.js";
import { validateConfig } from "./setup-logic.js";
import { listProfiles, switchProfile } from "./profiles.js";
import { getCachedUpdate, UPDATE_COMMAND } from "./update-check.js";
import pkg from "../package.json" with { type: "json" };

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
  "/profile",
  "/profile list",
  "/profile create",
  "/profile switch ",
  "/config show",
  ...CONFIG_KEYS.map((k) => `/config set ${k} `),
  "/verbose on",
  "/verbose off",
  "/version",
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
      "  /ask <question>        — submit a question to the network",
      "  /identity              — show agent_id and secret",
      "  /profile list          — list all profiles",
      "  /profile create        — create a new profile",
      "  /profile switch <name> — switch active profile",
      "  /config show           — show all config values",
      "  /config set <k> <v>    — change a config value",
      "  /verbose on|off        — toggle verbose logging",
      "  /version               — show version and check for updates",
      "  /exit                  — quit the application",
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

      const result: string[] = [`${key} = ${mask(key, String(value))}`];

      const check = validateConfig(updated as unknown as Record<string, string>);
      if (!check.ok) {
        result.push(`⚠ ${check.error}`);
      }

      return result;
    }

    return [`Usage: /config show | /config set <key> <value>`];
  }

  if (cmd === "profile") {
    const sub = parts[1]?.toLowerCase();

    if (!sub || sub === "list") {
      const profiles = listProfiles();
      if (profiles.length === 0) return ["No profiles configured."];
      const lines: string[] = ["Profiles:"];
      for (const p of profiles) {
        const marker = p.active ? " (active)" : "";
        lines.push(`  ${p.name}${marker}`);
      }
      return lines;
    }

    if (sub === "create") {
      return ["__CREATE_PROFILE__", "Starting profile creation..."];
    }

    if (sub === "switch") {
      const name = parts[2];
      if (!name) {
        const profiles = listProfiles();
        const lines = ["Usage: /profile switch <name>", "", "Available profiles:"];
        for (const p of profiles) {
          lines.push(`  ${p.name}${p.active ? " (active)" : ""}`);
        }
        return lines;
      }
      try {
        switchProfile(name);
        resetLlmClient();
        return [`__SWITCH_PROFILE__:${name}`, `Switched to profile "${name}". Restarting...`];
      } catch (err) {
        return [String(err instanceof Error ? err.message : err)];
      }
    }

    return [
      "Profile commands:",
      "  /profile list           — list all profiles",
      "  /profile create         — create a new profile",
      "  /profile switch <name>  — switch active profile",
    ];
  }

  if (cmd === "version") {
    const lines = [`Fortytwo Client v${pkg.version}`];
    const info = getCachedUpdate();
    if (info?.updateAvailable) {
      lines.push(`Update available: v${info.latestVersion}`);
      lines.push(`Run: ${UPDATE_COMMAND}`);
    }
    return lines;
  }

  return [`Unknown command: ${cmd}. Type "/help".`];
}
