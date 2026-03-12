import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput, Select, ThemeProvider, extendTheme, defaultTheme } from "@inkjs/ui";
import {
  saveConfig,
  reloadConfig,
  get as getConfig,
  type InferenceType,
} from "./config.js";
import { FortyTwoClient } from "./api-client.js";
import { registerAgent, saveIdentity } from "./identity.js";
import { validateModel, fetchModels, buildConfig } from "./setup-logic.js";
import { useLoader } from "./loader.js";
import { COLORS, ROLE_OPTIONS } from "./constants.js";
import { getRoleLabel } from "./utils.js";

type StepId =
  | "setup_mode"
  | "agent_name"
  | "agent_id"
  | "agent_secret"
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

const selectTheme = extendTheme(defaultTheme, {
  components: {
    Select: {
      styles: {
        focusIndicator: () => ({ color: COLORS.WHITE }),
        label: ({ isFocused }: { isFocused: boolean }) => ({
          color: isFocused ? COLORS.BLUE_CONTENT : undefined,
        }),
      },
    },
  },
});

const SETUP_MODE_OPTIONS = [
  { label: "Register new agent", value: "new" },
  { label: "Import existing agent", value: "import" },
];

const INFERENCE_OPTIONS = [
  { label: "OpenRouter", value: "openrouter" },
  { label: "Local inference", value: "local" },
];

function buildSteps(inferenceType?: InferenceType, setupMode?: string): StepDef[] {
  const steps: StepDef[] = [
    { id: "setup_mode", label: "Setup Mode", type: "select", options: SETUP_MODE_OPTIONS },
  ];

  if (setupMode === "import") {
    steps.push(
      { id: "agent_id", label: "Agent ID", type: "text", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
      { id: "agent_secret", label: "Agent Secret", type: "text", placeholder: "your-secret", mask: true },
    );
  } else {
    steps.push({ id: "agent_name", label: "Agent Name", type: "text", placeholder: "JudgeBot" });
  }

  steps.push({ id: "inference_type", label: "Inference Provider", type: "select", options: INFERENCE_OPTIONS });

  if (inferenceType === "local") {
    steps.push(
      { id: "llm_api_base", label: "Local API Base URL", type: "text", placeholder: "http://localhost:11434/v1" },
      { id: "llm_model", label: "Model Name", type: "text", placeholder: "llama3" },
    );
  } else if (inferenceType === "openrouter") {
    steps.push(
      { id: "openrouter_api_key", label: "OpenRouter API Key", type: "text", placeholder: "sk-or-...", mask: true },
      { id: "llm_model", label: "Model Name", type: "text", placeholder: "qwen/qwen3.5-35b-a3b" },
    );
  }

  steps.push({ id: "bot_role", label: "Bot Role", type: "select", options: ROLE_OPTIONS });

  return steps;
}

function displayValue(key: string, value: string): string {
  if (key === "openrouter_api_key" || key === "agent_secret") return "***";
  if (key === "setup_mode") return value === "import" ? "Import existing" : "Register new";
  if (key === "inference_type") return value === "local" ? "Local inference" : "OpenRouter";
  if (key === "bot_role") return getRoleLabel(value, "onboard");
  return value;
}

type Phase = "input" | "validating" | "validating_creds" | "fetching_models" | "registering" | "importing";

interface OnboardProps {
  onDone: () => void;
  skipToRegistration?: boolean;
}

export default function Onboard({ onDone, skipToRegistration }: OnboardProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [inferenceType, setInferenceType] = useState<InferenceType | undefined>();
  const [setupMode, setSetupMode] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>(skipToRegistration ? "registering" : "input");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [regLog, setRegLog] = useState<string[]>([]);
  const [regError, setRegError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState("");

  const isLoading = phase !== "input";
  const loader = useLoader(isLoading);

  useInput(() => {}, { isActive: true });

  const steps = buildSteps(inferenceType, setupMode);
  const step = steps[stepIdx];
  const isLast = stepIdx === steps.length - 1;

  // Autocomplete: filtered models for current query
  const modelQuery = modelFilter.toLowerCase();
  const filteredModels = step?.id === "llm_model" && modelQuery && availableModels.length > 0
    ? availableModels.filter((m) => m.toLowerCase().includes(modelQuery))
    : [];
  const isModelAutocomplete = phase === "input" && step?.id === "llm_model" && availableModels.length > 0;

  // Credentials validation (import flow)
  useEffect(() => {
    if (phase !== "validating_creds") return;

    let cancelled = false;
    (async () => {
      try {
        const client = new FortyTwoClient();
        await client.login(values.agent_id, values.agent_secret);

        // Fetch display name
        let displayName = values.agent_id;
        try {
          const agent = await client.getAgent();
          displayName = agent?.profile?.display_name || displayName;
        } catch { /* keep agent_id as name */ }

        if (cancelled) return;
        setValues((prev) => ({ ...prev, _display_name: displayName }));
        setValidationError(null);
        setPhase("input");
        setStepIdx(stepIdx + 1);
      } catch (err) {
        if (cancelled) return;
        // Return to agent_id step so user can fix either field
        const agentIdIdx = steps.findIndex((s) => s.id === "agent_id");
        setValues((prev) => {
          const { agent_id: _, agent_secret: __, ...rest } = prev;
          return rest;
        });
        setStepIdx(agentIdIdx >= 0 ? agentIdIdx : stepIdx);
        setValidationError(`✕ Invalid credentials: ${err}`);
        setPhase("input");
      }
    })();

    return () => { cancelled = true; };
  }, [phase === "validating_creds"]);

  // Fetch models after URL/key entry
  useEffect(() => {
    if (phase !== "fetching_models") return;

    let cancelled = false;
    const isLocal = values.inference_type === "local";
    const baseUrl = isLocal ? values.llm_api_base : "https://openrouter.ai/api/v1";
    const apiKey = isLocal ? "EMPTY" : values.openrouter_api_key;

    fetchModels(baseUrl, apiKey).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setValidationError(`✕ ${result.error ?? "Cannot reach server"}`);
        setPhase("input");
        return;
      }
      setAvailableModels(result.models);
      setValidationError(null);
      setPhase("input");
      setStepIdx(stepIdx + 1);
    });

    return () => { cancelled = true; };
  }, [phase === "fetching_models"]);

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
        setValidationError(`✕ ${result.error ?? "Validation failed"}`);
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
          setRegLog(["↳ Saving config..."]);
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

  // Import existing agent
  useEffect(() => {
    if (phase !== "importing") return;

    let cancelled = false;

    (async () => {
      try {
        setRegLog(["↳ Saving config..."]);
        const cfg = buildConfig(values);
        saveConfig(cfg);
        reloadConfig();

        saveIdentity(getConfig().identity_file, {
          agent_id: values.agent_id,
          secret: values.agent_secret,
        });

        const name = values._display_name || values.agent_id;
        setRegLog((prev) => [...prev, `✓ Agent "${name}" (${values.agent_id}) imported!`]);
        onDone();
      } catch (err) {
        if (cancelled) return;
        setRegError(String(err));
      }
    })();

    return () => { cancelled = true; };
  }, [phase === "importing"]);

  function advance(value: string) {
    const next = { ...values, [step!.id]: value };
    setValues(next);

    if (step!.id === "setup_mode") {
      setSetupMode(value);
    }

    if (step!.id === "inference_type") {
      setInferenceType(value as InferenceType);
    }

    if (step!.id === "agent_secret") {
      setValidationError(null);
      setPhase("validating_creds");
      return;
    }

    if (step!.id === "llm_api_base" || step!.id === "openrouter_api_key") {
      setValidationError(null);
      setPhase("fetching_models");
      return;
    }

    if (step!.id === "llm_model") {
      setValidationError(null);
      setPhase("validating");
      return;
    }

    if (isLast) {
      setPhase(setupMode === "import" ? "importing" : "registering");
    } else {
      setStepIdx(stepIdx + 1);
    }
  }

  if (!step && phase !== "registering" && phase !== "importing") return null;

  if (phase === "validating_creds") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          STEP {stepIdx + 1}/{steps.length}: {step!.label.toUpperCase()}
        </Text>
        <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> Checking credentials...</Text>
      </Box>
    );
  }

  if (phase === "fetching_models") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          STEP {stepIdx + 1}/{steps.length}: {step!.label.toUpperCase()}
        </Text>
        <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> Checking connection and fetching models...</Text>
      </Box>
    );
  }

  if (phase === "validating") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          STEP {stepIdx + 1}/{steps.length}: {step!.label.toUpperCase()}
        </Text>
        <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> Checking model...</Text>
      </Box>
    );
  }

  if (phase === "registering" || phase === "importing") {
    const displayLine = (line: string) => line.replace(/^\[progress]/, "");
    const last = regLog.length - 1;
    const header = phase === "importing" ? "IMPORT AGENT" : "REGISTRATION";

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>▒▓░ {header} ░▓▒</Text>
        {regLog.length === 0 && <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> ⎔ Registering Agent...</Text>}
        <Box flexDirection="column">
          {regLog.map((line, i) => {
            const isCurrent = i === last;
            const text = displayLine(line);
            return (
              <Text key={i} color={isCurrent ? undefined : COLORS.GREY_NEUTRAL}>
                {isCurrent ? <Text color={COLORS.BLUE_FRAME}> {loader} </Text> : "  "}{text}
              </Text>
            );
          })}
        </Box>
        {regError && <Text color={COLORS.RED}>✕ ERROR: {regError}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        STEP {stepIdx + 1}/{steps.length}: {step!.label.toUpperCase()}
      </Text>

      {validationError && (
        <Text color={COLORS.RED}>{validationError}</Text>
      )}

      <Text>
        {step!.label}
        {step!.placeholder ? <Text color={COLORS.GREY_NEUTRAL}> ({step!.placeholder})</Text> : null}
      </Text>

      {isModelAutocomplete ? (() => {
        const MAX_SHOWN = 5;
        const visible = filteredModels.slice(0, MAX_SHOWN);
        return (
          <>
            <Box>
              <Text color={COLORS.BLUE_FRAME} bold>❯ </Text>
              <TextInput
                key="llm_model_autocomplete"
                placeholder={step!.placeholder ?? ""}
                suggestions={availableModels}
                onChange={(val) => {
                  if (val === modelFilter) return;
                  setModelFilter(val);
                  setValidationError(null);
                }}
                onSubmit={(val) => {
                  const exact = availableModels.find((m) => m === val);
                  if (exact) { advance(val); return; }
                  const query = val.toLowerCase();
                  const matches = query ? availableModels.filter((m) => m.toLowerCase().includes(query)) : [];
                  if (matches.length === 1) { advance(matches[0]); return; }
                  if (!val) {
                    setValidationError("Type a model name to search");
                  } else if (matches.length === 0) {
                    setValidationError(`No models matching "${val}"`);
                  } else {
                    setValidationError(`${matches.length} matches — narrow your search`);
                  }
                }}
              />
            </Box>
            {modelQuery && filteredModels.length > 0 && (
              <Box flexDirection="column">
                {visible.map((m) => (
                  <Text key={m} color={COLORS.GREY_NEUTRAL}>  {m}</Text>
                ))}
                {filteredModels.length > MAX_SHOWN && (
                  <Text color={COLORS.GREY_NEUTRAL}>  +{filteredModels.length - MAX_SHOWN} more</Text>
                )}
              </Box>
            )}
            {modelQuery && filteredModels.length === 0 && (
              <Text color={COLORS.GREY_NEUTRAL}>No matches</Text>
            )}
            {!modelQuery && (
              <Text color={COLORS.GREY_NEUTRAL}>{availableModels.length} models available — type to search</Text>
            )}
          </>
        );
      })() : step!.type === "select" && step!.options ? (
        <ThemeProvider theme={selectTheme}>
          <Select key={step!.id} options={step!.options} onChange={(val) => advance(val)} />
        </ThemeProvider>
      ) : (
        <Box>
          <Text color={COLORS.BLUE_FRAME} bold>❯ </Text>
          <TextInput
            key={step!.id}
            placeholder={step!.placeholder ?? ""}
            onSubmit={(val) => advance(val)}
          />
        </Box>
      )}

      {Object.keys(values).length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.GREY_NEUTRAL}>─── configured ───</Text>
          {Object.entries(values).map(([k, v]) => (
            <Text key={k} color={COLORS.GREY_NEUTRAL}>
              {k}: {displayValue(k, v)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
