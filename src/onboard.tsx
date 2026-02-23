import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { TextInput, Select } from "@inkjs/ui";
import {
  saveConfig,
  reloadConfig,
  get as getConfig,
  type InferenceType,
} from "./config.js";
import { FortyTwoClient } from "./api-client.js";
import { registerAgent, saveIdentity } from "./identity.js";
import { validateModel, buildConfig } from "./setup-logic.js";

const COLOR = "rgb(42, 42, 242)";

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

const SETUP_MODE_OPTIONS = [
  { label: "Register new agent", value: "new" },
  { label: "Import existing agent", value: "import" },
];

const INFERENCE_OPTIONS = [
  { label: "OpenRouter", value: "openrouter" },
  { label: "Local inference", value: "local" },
];

const ROLE_OPTIONS = [
  { label: "JUDGE — only judge challenges", value: "JUDGE" },
  { label: "ANSWERER — only answer queries", value: "ANSWERER" },
  { label: "ANSWERER_AND_JUDGE — both", value: "ANSWERER_AND_JUDGE" },
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
      { id: "llm_model", label: "Model Name", type: "text", placeholder: "z-ai/glm-4.7-flash" },
    );
  }

  steps.push({ id: "bot_role", label: "Bot Role", type: "select", options: ROLE_OPTIONS });

  return steps;
}

function displayValue(key: string, value: string): string {
  if (key === "openrouter_api_key" || key === "agent_secret") return "***";
  if (key === "setup_mode") return value === "import" ? "Import existing" : "Register new";
  if (key === "inference_type") return value === "local" ? "Local inference" : "OpenRouter";
  return value;
}

type Phase = "input" | "validating" | "validating_creds" | "registering" | "importing";

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

  const steps = buildSteps(inferenceType, setupMode);
  const step = steps[stepIdx];
  const isLast = stepIdx === steps.length - 1;

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
        setValidationError(`Invalid credentials: ${err}`);
        setPhase("input");
      }
    })();

    return () => { cancelled = true; };
  }, [phase === "validating_creds"]);

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

  // Import existing agent
  useEffect(() => {
    if (phase !== "importing") return;

    let cancelled = false;

    (async () => {
      try {
        setRegLog(["Saving config..."]);
        const cfg = buildConfig(values);
        saveConfig(cfg);
        reloadConfig();

        saveIdentity(getConfig().identity_file, {
          agent_id: values.agent_id,
          secret: values.agent_secret,
        });

        const name = values._display_name || values.agent_id;
        setRegLog((prev) => [...prev, `Agent "${name}" (${values.agent_id}) imported!`]);
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
        <Text color={COLOR} bold>
          Setup ({stepIdx + 1}/{steps.length})
        </Text>
        <Text color="yellow">Checking credentials...</Text>
      </Box>
    );
  }

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

  if (phase === "registering" || phase === "importing") {
    const displayLine = (line: string) => line.replace(/^\[progress]/, "");
    const last = regLog.length - 1;
    const header = phase === "importing" ? "Import Agent" : "Registration";

    return (
      <Box flexDirection="column" gap={1}>
        <Text color={COLOR} bold>{header}</Text>
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
