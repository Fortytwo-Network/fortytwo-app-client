import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput, Select, ThemeProvider, extendTheme, defaultTheme } from "@inkjs/ui";
import {
  reloadConfig,
  get as getConfig,
  type InferenceType,
} from "./config.js";
import { FortyTwoClient } from "./api-client.js";
import { registerAgent } from "./identity.js";
import { validateConfig, validateModel, fetchModels, buildConfig } from "./setup-logic.js";
import { createProfile, sanitizeProfileName } from "./profiles.js";
import { useLoader } from "./loader.js";
import { COLORS, ROLE_OPTIONS } from "./constants.js";
import { getRoleLabel } from "./utils.js";

type StepId =
  | "setup_mode"
  | "node_name"
  | "node_id"
  | "node_secret"
  | "inference_type"
  | "openrouter_api_key"
  | "self_hosted_api_base"
  | "model_name"
  | "node_role";

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
        selectedIndicator: () => ({ display: "none" as const }),
      },
    },
  },
});

const SETUP_MODE_OPTIONS = [
  { label: "Register new node", value: "new" },
  { label: "Import existing node", value: "import" },
];

const INFERENCE_OPTIONS = [
  { label: "OpenRouter", value: "openrouter" },
  { label: "Self-hosted inference", value: "self-hosted" },
];

function buildSteps(inferenceType?: InferenceType, setupMode?: string): StepDef[] {
  const steps: StepDef[] = [
    { id: "setup_mode", label: "Setup Mode", type: "select", options: SETUP_MODE_OPTIONS },
  ];

  if (setupMode === "import") {
    steps.push(
      { id: "node_id", label: "Node ID", type: "text", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
      { id: "node_secret", label: "Node Secret", type: "text", placeholder: "your-secret", mask: true },
    );
  } else {
    steps.push({ id: "node_name", label: "Node Name", type: "text", placeholder: "JudgeNode" });
  }

  steps.push({ id: "inference_type", label: "Inference Provider", type: "select", options: INFERENCE_OPTIONS });

  if (inferenceType === "self-hosted") {
    steps.push(
      { id: "self_hosted_api_base", label: "Local API Base URL", type: "text", placeholder: "http://localhost:11434/v1" },
      { id: "model_name", label: "Model Name", type: "text", placeholder: "llama3" },
    );
  } else if (inferenceType === "openrouter") {
    steps.push(
      { id: "openrouter_api_key", label: "OpenRouter API Key", type: "text", placeholder: "sk-or-...", mask: true },
      { id: "model_name", label: "Model Name", type: "text", placeholder: "qwen/qwen3.5-35b-a3b" },
    );
  }

  steps.push({ id: "node_role", label: "Node Role", type: "select", options: ROLE_OPTIONS });

  return steps;
}

function displayValue(key: string, value: string): string {
  if (key === "openrouter_api_key" || key === "node_secret") return "***";
  if (key === "setup_mode") return value === "import" ? "Import existing" : "Register new";
  if (key === "inference_type") return value === "self-hosted" ? "Self-hosted inference" : "OpenRouter";
  if (key === "node_role") return getRoleLabel(value, "onboard");
  return value;
}

type Phase = "input" | "validating" | "validating_creds" | "fetching_models" | "registering" | "importing";

interface OnboardProps {
  onDone: () => void;
  skipToRegistration?: boolean;
  onCancel?: () => void;
  onStepChange?: (step: { current: number; total: number; label: string } | null) => void;
  initialSetupMode?: "new" | "import";
}

export default function Onboard({
  onDone,
  skipToRegistration,
  onCancel,
  onStepChange,
  initialSetupMode,
}: OnboardProps) {
  const [stepIdx, setStepIdx] = useState(initialSetupMode ? 1 : 0);
  const [values, setValues] = useState<Record<string, string>>(
    initialSetupMode ? { setup_mode: initialSetupMode } : {},
  );
  const [inferenceType, setInferenceType] = useState<InferenceType | undefined>();
  const [setupMode, setSetupMode] = useState<string | undefined>(initialSetupMode);
  const [phase, setPhase] = useState<Phase>(skipToRegistration ? "registering" : "input");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [regLog, setRegLog] = useState<string[]>([]);
  const [regError, setRegError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [backFocused, setBackFocused] = useState(false);

  const isLoading = phase !== "input";
  const loader = useLoader(isLoading);

  const steps = buildSteps(inferenceType, setupMode);
  const step = steps[stepIdx];
  const canGoBack = stepIdx > 0;

  useEffect(() => {
    if (!onStepChange) return;
    if (!step) {
      onStepChange(null);
      return;
    }
    onStepChange({
      current: stepIdx + 1,
      total: steps.length,
      label: step.label.toUpperCase(),
    });
  }, [onStepChange, stepIdx, step?.label, steps.length]);

  useEffect(() => () => onStepChange?.(null), [onStepChange]);

  function goBack() {
    if (!canGoBack) return;
    const prevStep = steps[stepIdx - 1];
    setValidationError(null);
    setModelFilter(prevStep.id === "model_name" ? (values["model_name"] ?? "") : "");
    setBackFocused(false);
    setStepIdx(stepIdx - 1);
  }

  useInput((_input, key) => {
    if (phase !== "input" || !canGoBack) return;
    // Only handle for TextInput steps — Select steps use "← Back" option
    if (step?.type === "select") return;

    if (key.downArrow && !backFocused) {
      setBackFocused(true);
    }
    if (key.upArrow && backFocused) {
      setBackFocused(false);
    }
    if (key.return && backFocused) {
      setBackFocused(false);
      goBack();
    }
  }, { isActive: true });

  const isLast = stepIdx === steps.length - 1;

  // Autocomplete: filtered models for current query
  const modelQuery = modelFilter.toLowerCase();
  const filteredModels = step?.id === "model_name" && modelQuery && availableModels.length > 0
    ? availableModels.filter(m => m.toLowerCase().includes(modelQuery.toLowerCase()))
    : [];
  const isModelAutocomplete = phase === "input" && step?.id === "model_name" && availableModels.length > 0;

  // Credentials validation (import flow)
  useEffect(() => {
    if (phase !== "validating_creds") return;

    let cancelled = false;
    (async () => {
      try {
        const client = new FortyTwoClient();
        await client.login(values.node_id, values.node_secret);

        // Fetch display name
        let displayName = values.node_id;
        try {
          const agent = await client.getAgent();
          displayName = agent?.profile?.display_name || displayName;
        } catch { /* keep node_id as name */ }

        if (cancelled) return;
        setValues((prev) => ({ ...prev, _node_display_name: displayName }));
        setValidationError(null);
        setPhase("input");
        setStepIdx(stepIdx + 1);
      } catch (err) {
        if (cancelled) return;
        // Return to node_id step so user can fix either field
        const nodeIdIdx = steps.findIndex((s) => s.id === "node_id");
        setValues((prev) => {
          const { node_id: _, node_secret: __, ...rest } = prev;
          return rest;
        });
        setStepIdx(nodeIdIdx >= 0 ? nodeIdIdx : stepIdx);
        const msg = err instanceof Error ? err.message : typeof err === "object" && err !== null && "message" in err ? String((err as Record<string, unknown>).message) : String(err);
        setValidationError(`✕ Invalid credentials: ${msg}`);
        setPhase("input");
      }
    })();

    return () => { cancelled = true; };
  }, [phase === "validating_creds"]);

  // Fetch models after URL/key entry
  useEffect(() => {
    if (phase !== "fetching_models") return;

    let cancelled = false;
    const isLocal = values.inference_type === "self-hosted";
    const baseUrl = isLocal ? values.self_hosted_api_base : "https://openrouter.ai/api/v1";
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
      setModelFilter(values["model_name"] ?? "");
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
          const profileName = sanitizeProfileName(values.node_name || "default");
          createProfile(profileName, cfg);
          reloadConfig();
        }

        const cfg = getConfig();

        // Show inference info
        const isLocal = cfg.inference_type === "self-hosted";
        const finalLines = [
          `Role: ${cfg.node_role}`,
          `Inference: ${cfg.inference_type}`,
          ...(isLocal ? [`Host: ${cfg.self_hosted_api_base}`] : []),
          `Model: ${cfg.model_name}`,
          "",
        ];
        setRegLog((prev) => [...prev, ...finalLines]);

        // Validate config fields
        const cfgCheck = validateConfig(cfg as unknown as Record<string, string>);
        if (cfgCheck.ok) {
          setRegLog((prev) => [...prev, "Validating model..."]);
          const modelCheck = await validateModel(cfg as unknown as Record<string, string>);
          if (!modelCheck.ok) {
            setRegError(`Config error: ${modelCheck.error}`);
            return;
          }
          setRegLog((prev) => [...prev, "✓ Model validated"]);
        } else {
          setRegError(`Config error: ${cfgCheck.error}`);
          return;
        }

        const client = new FortyTwoClient();
        const displayName = cfg.node_display_name || values.node_name || "JudgeNode";
        await registerAgent(client, displayName, (msg) => {
          if (cancelled) return;
          setRegLog((prev) => [...prev, msg]);
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

  // Import existing node
  useEffect(() => {
    if (phase !== "importing") return;

    let cancelled = false;

    (async () => {
      try {
        setRegLog(["↳ Saving config..."]);
        const cfg = buildConfig(values);
        const profileName = sanitizeProfileName(values._node_display_name || values.node_id || "default");
        createProfile(profileName, cfg, {
          node_id: values.node_id,
          node_secret: values.node_secret,
        });
        reloadConfig();

        const name = values._node_display_name || values.node_id;
        setRegLog((prev) => [...prev, `✓ Node "${name}" (${values.node_id}) imported!`]);
        onDone();
      } catch (err) {
        if (cancelled) return;
        setRegError(String(err));
      }
    })();

    return () => { cancelled = true; };
  }, [phase === "importing"]);

  function advance(value: string) {
    if (value === "__cancel__" && onCancel) {
      onCancel();
      return;
    }
    if (value === "__back__") {
      goBack();
      return;
    }
    const next = { ...values, [step!.id]: value };
    const previousValue = values[step!.id];

    // Branch change: clear dependent values when branching select changes
    if (step!.id === "setup_mode" && previousValue !== undefined && previousValue !== value) {
      delete next["node_name"];
      delete next["node_id"];
      delete next["node_secret"];
      delete next["_node_display_name"];
    }

    if (step!.id === "inference_type" && previousValue !== undefined && previousValue !== value) {
      delete next["openrouter_api_key"];
      delete next["self_hosted_api_base"];
      delete next["model_name"];
      delete next["node_role"];
      setAvailableModels([]);
    }

    setValues(next);

    if (step!.id === "setup_mode") {
      setSetupMode(value);
    }

    if (step!.id === "inference_type") {
      setInferenceType(value as InferenceType);
    }

    if (step!.id === "node_secret") {
      setValidationError(null);
      setPhase("validating_creds");
      return;
    }

    if (step!.id === "self_hosted_api_base" || step!.id === "openrouter_api_key") {
      setValidationError(null);
      setPhase("fetching_models");
      return;
    }

    if (step!.id === "model_name") {
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
        <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> Checking credentials...</Text>
      </Box>
    );
  }

  if (phase === "fetching_models") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> Checking connection and fetching models...</Text>
      </Box>
    );
  }

  if (phase === "validating") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> Checking model...</Text>
      </Box>
    );
  }

  if (phase === "registering" || phase === "importing") {
    const last = regLog.length - 1;
    const header = phase === "importing" ? "IMPORT NODE" : "REGISTRATION";

    return (
      <Box flexDirection="column" gap={1}>
        <Text color={COLORS.BLUE_CONTENT} bold>{header}</Text>
        {regLog.length === 0 && <Text><Text color={COLORS.BLUE_FRAME}> {loader} </Text> ⎔ Registering Node...</Text>}
        <Box flexDirection="column">
          {regLog.map((line, i) => {
            const isCurrent = i === last;
            return (
              <Text key={i} color={isCurrent ? undefined : COLORS.GREY_NEUTRAL}>
                {isCurrent ? <Text color={COLORS.BLUE_FRAME}> {loader} </Text> : "   "}{line}
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
      {validationError && (
        <Text color={COLORS.RED}>{validationError}</Text>
      )}

      {isModelAutocomplete ? (() => {
        const MAX_SHOWN = 5;
        const visible = filteredModels.slice(0, MAX_SHOWN);
        return (
          <>
            <Box>
              <Text color={COLORS.BLUE_FRAME} bold>{backFocused ? "  " : "❯ "}</Text>
              <TextInput
                key="model_name_autocomplete"
                isDisabled={backFocused}
                defaultValue={values[step!.id] ?? ""}
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
            {canGoBack && (
              <Text color={backFocused ? COLORS.BLUE_CONTENT : COLORS.GREY_NEUTRAL}>
                {backFocused ? "❯" : " "} ← Back
              </Text>
            )}
          </>
        );
      })() : step!.type === "select" && step!.options ? (
        <ThemeProvider theme={selectTheme}>
          <Select
            key={`${step!.id}-${stepIdx}`}
            options={(() => {
              const savedValue = values[step!.id];
              const base = step!.options!;
              const ordered = savedValue
                ? [...base.filter(o => o.value === savedValue), ...base.filter(o => o.value !== savedValue)]
                : base;
              if (canGoBack) return [...ordered, { label: "Back", value: "__back__" }];
              if (onCancel && stepIdx === 0) return [...ordered, { label: "Back", value: "__cancel__" }];
              return ordered;
            })()}
            onChange={(val) => advance(val)}
          />
        </ThemeProvider>
      ) : (
        <>
          <Box>
            <Text color={COLORS.BLUE_FRAME} bold>{backFocused ? "  " : "❯ "}</Text>
            <TextInput
              key={step!.id}
              isDisabled={backFocused}
              defaultValue={values[step!.id] ?? ""}
              placeholder={step!.placeholder ?? ""}
              onSubmit={(val) => advance(val)}
            />
          </Box>
          {canGoBack && (
            <Text color={backFocused ? COLORS.BLUE_CONTENT : COLORS.GREY_NEUTRAL}>
              {backFocused ? "❯" : " "} ← Back
            </Text>
          )}
        </>
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
