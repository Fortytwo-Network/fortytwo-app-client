import { join } from "node:path";
import {
  type UserConfig,
  type InferenceType,
  getConfigDir,
} from "./config.js";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

export interface FetchModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export async function fetchModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, models: [], error: `Cannot reach ${url} — is the server running?` };
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, models: [], error: `Auth rejected (${resp.status})` };
    }
    return { ok: false, models: [], error: `API returned ${resp.status}` };
  }

  try {
    const data = (await resp.json()) as any;
    const models: string[] = (data.data ?? []).map((m: any) => m.id);
    return { ok: true, models };
  } catch {
    return { ok: true, models: [] };
  }
}

export function validateConfig(values: Record<string, string>): ValidateResult {
  const inferenceType = values.inference_type;
  if (inferenceType !== "openrouter" && inferenceType !== "self-hosted") {
    return { ok: false, error: `inference_type is invalid: "${inferenceType}". Options: "openrouter" | "self-hosted"` };
  }

  if (inferenceType === "openrouter" && !values.openrouter_api_key) {
    return { ok: false, error: `openrouter_api_key is required for OpenRouter inference. Use /config set openrouter_api_key <key>` };
  }
  if (inferenceType === "self-hosted" && !values.self_hosted_api_base) {
    return { ok: false, error: `self_hosted_api_base is not set for local inference. Use /config set self_hosted_api_base <url>` };
  }

  if (!values.model_name) {
    return { ok: false, error: `model_name is not set. Use /config set model_name <model>` };
  }
  return { ok: true };
}

export async function validateModel(values: Record<string, string>): Promise<ValidateResult> {
  const isLocal = values.inference_type === "self-hosted";
  const baseUrl = isLocal
    ? values.self_hosted_api_base?.replace(/\/+$/, "")
    : OPENROUTER_BASE;
  const apiKey = isLocal ? "EMPTY" : values.openrouter_api_key;
  const model = values.model_name;

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
      return { ok: false, error: `Model "${model}" not found. Choose correct one and restart the client.` };
    }
  } catch {
    return { ok: true };
  }

  return { ok: true };
}

export function buildConfig(values: Record<string, string>): UserConfig {
  const isLocal = values.inference_type === "self-hosted";
  return {
    node_name: values.node_name || values.node_display_name || values.node_id || "",
    node_display_name: values.node_name || values.node_display_name || values.node_id || "",
    inference_type: isLocal ? "self-hosted" : "openrouter",
    openrouter_api_key: values.openrouter_api_key ?? "",
    self_hosted_api_base: values.self_hosted_api_base ?? "",
    fortytwo_api_base: values.fortytwo_api_base ?? "https://app.fortytwo.network/api",
    node_identity_file: values.node_identity_file ?? join(getConfigDir(), "identity.json"),
    poll_interval: Number(values.poll_interval) || 120,
    model_name: values.model_name || (isLocal ? "" : "qwen/qwen3.5-35b-a3b"),
    llm_concurrency: 40,
    llm_timeout: 120,
    min_balance: 5.0,
    node_role: values.node_role || "JUDGE",
    answerer_system_prompt: "You are a helpful assistant.",
  };
}
