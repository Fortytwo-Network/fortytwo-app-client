import { join } from "node:path";
import {
  type UserConfig,
  type InferenceType,
  CONFIG_DIR,
} from "./config.js";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

export async function validateModel(values: Record<string, string>): Promise<ValidateResult> {
  const isLocal = values.inference_type === "local";
  const baseUrl = isLocal
    ? values.llm_api_base?.replace(/\/+$/, "")
    : OPENROUTER_BASE;
  const apiKey = isLocal ? "EMPTY" : values.openrouter_api_key;
  const model = values.llm_model;

  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };

  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    const msg = isLocal
      ? `Cannot reach ${url} — is the server running?`
      : `Cannot reach OpenRouter API: ${err}`;
    return { ok: false, error: msg };
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: isLocal ? `Auth rejected (${resp.status})` : "Invalid API key" };
    }
    return { ok: false, error: `API returned ${resp.status}` };
  }

  try {
    const data = (await resp.json()) as any;
    const models: string[] = (data.data ?? []).map((m: any) => m.id);

    if (models.length === 0) {
      return { ok: true };
    }

    if (!models.includes(model)) {
      return { ok: false, error: `Model "${model}" not found. Available: ${models.slice(0, 5).join(", ")}${models.length > 5 ? ` (+${models.length - 5} more)` : ""}` };
    }
  } catch {
    return { ok: true };
  }

  return { ok: true };
}

export function buildConfig(values: Record<string, string>): UserConfig {
  const isLocal = values.inference_type === "local";
  return {
    agent_name: values.agent_name || values._display_name || values.agent_id || "",
    display_name: values.agent_name || values._display_name || values.agent_id || "",
    inference_type: isLocal ? "local" : "openrouter",
    openrouter_api_key: values.openrouter_api_key ?? "",
    llm_api_base: values.llm_api_base ?? "",
    fortytwo_api_base: "https://app.fortytwo.network/api",
    identity_file: join(CONFIG_DIR, "identity.json"),
    poll_interval: 120,
    llm_model: values.llm_model || (isLocal ? "" : "z-ai/glm-4.7-flash"),
    llm_concurrency: 40,
    llm_timeout: 120,
    min_balance: 5.0,
    bot_role: values.bot_role || "JUDGE",
    answerer_system_prompt: "You are a helpful assistant.",
  };
}
