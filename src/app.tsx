import { hostname, userInfo } from "node:os";
import { useState, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { configExists, reloadConfig, get as getConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import { resetLlmClient } from "./llm.js";
import { COLORS } from "./constants.js";
import Onboard from "./onboard.js";
import BotScreen from "./bot.js";
import { LogoMark } from "./logo-mark.js";

type Screen = "onboard" | "register" | "running";

function getShellPrompt(): string {
  try {
    const user = userInfo().username || "user";
    const host = hostname().split(".")[0] || "localhost";
    return `${user}@${host} ~ % fortytwo`;
  } catch {
    return "fortytwo";
  }
}

const SHELL_PROMPT = getShellPrompt();

function getInitialScreen(): Screen {
  if (!configExists()) return "onboard";
  const cfg = getConfig();
  if (!cfg.node_identity_file || !loadIdentity(cfg.node_identity_file)) return "register";
  return "running";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const [botKey, setBotKey] = useState(0);
  const [onboardStep, setOnboardStep] = useState<{ current: number; total: number; label: string } | null>(null);

  const handleSwitchProfile = useCallback(() => {
    resetLlmClient();
    setBotKey((k) => k + 1);
  }, []);

  const fromCreateRef = useRef(false);

  const handleCreateProfile = useCallback(() => {
    fromCreateRef.current = true;
    setScreen("onboard");
  }, []);

  const handleCancelCreate = useCallback(() => {
    fromCreateRef.current = false;
    setOnboardStep(null);
    setScreen("running");
  }, []);

  const handleOnboardDone = useCallback(() => {
    fromCreateRef.current = false;
    setOnboardStep(null);
    reloadConfig();
    resetLlmClient();
    setBotKey((k) => k + 1);
    setScreen("running");
  }, []);

  return (
    <Box flexDirection="column">
      {screen !== "running" && (
        <Box flexDirection="column" key="logo-box">
          <Text color={COLORS.WHITE}>{SHELL_PROMPT}</Text>
          <Box marginTop={3}>
            <LogoMark height={5} />
            <Box flexDirection="column" marginLeft={2}>
              <Text>
                <Text color={COLORS.WHITE} bold>WELCOME TO </Text>
                <Text color={COLORS.BLUE_CONTENT} bold>FORTYTWO</Text>
              </Text>
              <Text color={COLORS.WHITE} bold>NODERUNNER</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.BLUE_CONTENT} bold>ONBOARDING</Text>
                {onboardStep ? (
                  <Text>
                    <Text color={COLORS.BLUE_FRAME} bold>STEP</Text> {onboardStep.current}/{onboardStep.total}: {onboardStep.label}
                  </Text>
                ) : null}
              </Box>
            </Box>
          </Box>
        </Box>
      )}

      <Box>
        {screen === "onboard" && (
          <Onboard
            onDone={handleOnboardDone}
            onCancel={fromCreateRef.current ? handleCancelCreate : undefined}
            onStepChange={setOnboardStep}
          />
        )}

        {screen === "register" && (
          <Onboard skipToRegistration onDone={handleOnboardDone} onStepChange={setOnboardStep} />
        )}

        {screen === "running" && (
          <BotScreen key={botKey} onSwitchProfile={handleSwitchProfile} onCreateProfile={handleCreateProfile} />
        )}
      </Box>
    </Box>
  );
}
