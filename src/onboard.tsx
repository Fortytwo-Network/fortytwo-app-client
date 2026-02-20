import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { TextInput, Select } from "@inkjs/ui";
import { join } from "node:path";
import {
  saveConfig,
  reloadConfig,
  get as getConfig,
  CONFIG_DIR,
  type UserConfig,
  type InferenceType,
} from "./config.js";
import { FortyTwoClient } from "./api-client.js";
import { registerAgent } from "./identity.js";

const COLOR = "rgb(42, 42, 242)";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

type StepId =
  | "agent_name"
  | "inference_type"
  | "openrouter_api_key"
  | "llm_api_base"
  | "llm_model"
  | "bot_role";

interface StepDef {
  id: StepId;
  label: string;
  type: "text" | "select";
  placeholder?: string;
  mask?: boolean;
  options?: { label: string; value: string }[];
}

const INFERENCE_OPTIONS = [
  { label: "OpenRouter", value: "openrouter" },
  { label: "Local inference", value: "local" },
];

const ROLE_OPTIONS = [
  { label: "JUDGE — only judge challenges", value: "JUDGE" },
  { label: "ANSWERER — only answer queries", value: "ANSWERER" },
  { label: "ANSWERER_AND_JUDGE — both", value: "ANSWERER_AND_JUDGE" },
];

function buildSteps(inferenceType?: InferenceType): StepDef[] {
  const steps: StepDef[] = [
    { id: "agent_name", label: "Agent Name", type: "text", placeholder: "JudgeBot" },
    { id: "inference_type", label: "Inference Provider", type: "select", options: INFERENCE_OPTIONS },
  ];

  if (inferenceType === "local") {
    steps.push(
      { id: "llm_api_base", label: "Local API Base URL", type: "text", placeholder: "http://localhost:11434/v1" },
      { id: "llm_model", label: "Model Name", type: "text", placeholder: "llama3" },
    );
  } else if (inferenceType === "openrouter") {
    steps.push(
      { id: "openrouter_api_key", label: "OpenRouter API Key", type: "text", placeholder: "sk-or-...", mask: true },
      { id: "llm_model", label: "Model Name", type: "text", placeholder: "z-ai/glm-4.7-flash" },
    );
  }

  steps.push({ id: "bot_role", label: "Bot Role", type: "select", options: ROLE_OPTIONS });

  return steps;
}

function displayValue(key: string, value: string): string {
  if (key === "openrouter_api_key") return "***";
  if (key === "inference_type") return value === "local" ? "Local inference" : "OpenRouter";
  return value;
}

interface ValidateResult {
  ok: boolean;
  error?: string;
}

async function validateModel(values: Record<string, string>): Promise<ValidateResult> {
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

function buildConfig(values: Record<string, string>): UserConfig {
  const isLocal = values.inference_type === "local";
  return {
    agent_name: values.agent_name ?? "",
    display_name: values.agent_name ?? "",
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

type Phase = "input" | "validating" | "registering";

interface OnboardProps {
  onDone: () => void;
  skipToRegistration?: boolean;
}

export default function Onboard({ onDone, skipToRegistration }: OnboardProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [inferenceType, setInferenceType] = useState<InferenceType | undefined>();
  const [phase, setPhase] = useState<Phase>(skipToRegistration ? "registering" : "input");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [regLog, setRegLog] = useState<string[]>([]);
  const [regError, setRegError] = useState<string | null>(null);

  const steps = buildSteps(inferenceType);
  const step = steps[stepIdx];
  const isLast = stepIdx === steps.length - 1;

  // Model validation
  useEffect(() => {
    if (phase !== "validating") return;

    let cancelled = false;
    validateModel(values).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setValidationError(null);
        setPhase("input");
        setStepIdx(stepIdx + 1);
      } else {
        setValidationError(result.error ?? "Validation failed");
        setPhase("input");
      }
    });

    return () => { cancelled = true; };
  }, [phase === "validating"]);

  // Registration
  useEffect(() => {
    if (phase !== "registering") return;

    let cancelled = false;

    (async () => {
      try {
        if (!skipToRegistration) {
          setRegLog(["Saving config..."]);
          const cfg = buildConfig(values);
          saveConfig(cfg);
          reloadConfig();
        }

        const cfg = getConfig();
        const client = new FortyTwoClient();
        const displayName = cfg.display_name || values.agent_name || "JudgeBot";
        await registerAgent(client, displayName, (msg) => {
          if (cancelled) return;
          if (msg.startsWith("~")) {
            // Replace last line (progress update)
            const text = msg.slice(1);
            setRegLog((prev) => {
              if (prev.length > 0 && prev[prev.length - 1].startsWith("[progress]")) {
                return [...prev.slice(0, -1), `[progress]${text}`];
              }
              return [...prev, `[progress]${text}`];
            });
          } else {
            setRegLog((prev) => [...prev, msg]);
          }
        });

        if (cancelled) return;
        onDone();
      } catch (err) {
        if (cancelled) return;
        setRegError(String(err));
      }
    })();

    return () => { cancelled = true; };
  }, [phase === "registering"]);

  function advance(value: string) {
    const next = { ...values, [step!.id]: value };
    setValues(next);

    if (step!.id === "inference_type") {
      setInferenceType(value as InferenceType);
    }

    if (step!.id === "llm_model") {
      setValidationError(null);
      setPhase("validating");
      return;
    }

    if (isLast) {
      setPhase("registering");
    } else {
      setStepIdx(stepIdx + 1);
    }
  }

  if (!step && phase !== "registering") return null;

  if (phase === "validating") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={COLOR} bold>
          Setup ({stepIdx + 1}/{steps.length})
        </Text>
        <Text color="yellow">Checking connection and model...</Text>
      </Box>
    );
  }

  if (phase === "registering") {
    const displayLine = (line: string) => line.replace(/^\[progress]/, "");
    const last = regLog.length - 1;

    return (
      <Box flexDirection="column" gap={1}>
        <Text color={COLOR} bold>Registration</Text>
        {regLog.length === 0 && <Text color="yellow">Starting registration...</Text>}
        <Box flexDirection="column">
          {regLog.map((line, i) => {
            const isCurrent = i === last;
            const text = displayLine(line);
            return (
              <Text key={i} color={isCurrent ? "yellow" : undefined} dimColor={!isCurrent}>
                {isCurrent ? "▸ " : "  "}{text}
              </Text>
            );
          })}
        </Box>
        {regError && <Text color="red">{regError}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={COLOR} bold>
        Setup ({stepIdx + 1}/{steps.length})
      </Text>

      {validationError && (
        <Text color="red">{validationError}</Text>
      )}

      <Text>
        {step!.label}
        {step!.placeholder ? <Text dimColor> ({step!.placeholder})</Text> : null}
      </Text>

      {step!.type === "select" && step!.options ? (
        <Select key={step!.id} options={step!.options} onChange={(val) => advance(val)} />
      ) : (
        <TextInput
          key={step!.id}
          placeholder={step!.placeholder ?? ""}
          onSubmit={(val) => advance(val)}
        />
      )}

      {Object.keys(values).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>─── configured ───</Text>
          {Object.entries(values).map(([k, v]) => (
            <Text key={k} dimColor>
              {k}: {displayValue(k, v)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
