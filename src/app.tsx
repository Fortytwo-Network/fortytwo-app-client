import { hostname, userInfo } from "node:os";
import { useState, useCallback, useRef } from "react";
import { Box, Text } from "ink";
import { Select, ThemeProvider, extendTheme, defaultTheme } from "@inkjs/ui";
import { configExists, reloadConfig, get as getConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import { resetLlmClient } from "./llm.js";
import { COLORS } from "./constants.js";
import Onboard from "./onboard.js";
import BotScreen from "./bot.js";
import { LogoMark } from "./logo-mark.js";
import { listProfiles, switchProfile } from "./profiles.js";
import type { ProfileInfo } from "./profiles.js";

type Screen = "profile_select" | "onboard" | "register" | "running";

const PROFILE_REGISTER_VALUE = "__register__";
const PROFILE_IMPORT_VALUE = "__import__";

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
  if (listProfiles().length > 0) return "profile_select";
  if (!configExists()) return "onboard";
  const cfg = getConfig();
  if (!cfg.node_identity_file || !loadIdentity(cfg.node_identity_file)) return "register";
  return "running";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const [botKey, setBotKey] = useState(0);
  const [onboardStep, setOnboardStep] = useState<{ current: number; total: number; label: string } | null>(null);
  const [onboardMode, setOnboardMode] = useState<"new" | "import" | undefined>();
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileList, setProfileList] = useState<ProfileInfo[]>(() => listProfiles());

  const handleSwitchProfile = useCallback(() => {
    resetLlmClient();
    setBotKey((k) => k + 1);
  }, []);

  const fromCreateRef = useRef(false);

  const handleCreateProfile = useCallback(() => {
    fromCreateRef.current = true;
    setOnboardMode(undefined);
    setScreen("onboard");
  }, []);

  const handleCancelCreate = useCallback(() => {
    fromCreateRef.current = false;
    setOnboardMode(undefined);
    setOnboardStep(null);
    setScreen("running");
  }, []);

  const handleOnboardDone = useCallback(() => {
    fromCreateRef.current = false;
    setOnboardMode(undefined);
    setOnboardStep(null);
    reloadConfig();
    resetLlmClient();
    setProfileList(listProfiles());
    setBotKey((k) => k + 1);
    setScreen("running");
  }, []);

  const handleProfileSelect = useCallback((value: string) => {
    setProfileError(null);
    if (value === PROFILE_REGISTER_VALUE) {
      setOnboardMode("new");
      setScreen("onboard");
      return;
    }
    if (value === PROFILE_IMPORT_VALUE) {
      setOnboardMode("import");
      setScreen("onboard");
      return;
    }
    if (!value.startsWith("profile:")) return;

    const profileName = value.slice("profile:".length);
    try {
      switchProfile(profileName);
      reloadConfig();
      resetLlmClient();
      setBotKey((k) => k + 1);
      setScreen("running");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const profileOptions = [
    { label: "Register new node", value: PROFILE_REGISTER_VALUE },
    { label: "Import existing node", value: PROFILE_IMPORT_VALUE },
    ...profileList.map((p) => {
      const name = p.agentName || p.name;
      const marker = p.active ? " (last used)" : "";
      return { label: `${name}${marker}`, value: `profile:${p.name}` };
    }),
  ];
  const titleText = screen === "profile_select" ? "SELECT PROFILE" : "ONBOARDING";
  const logoHeight = screen === "profile_select" ? 4 : 5;

  return (
    <Box flexDirection="column">
      {screen !== "running" && (
        <Box flexDirection="column" key="logo-box">
          <Text color={COLORS.WHITE}>{SHELL_PROMPT}</Text>
          <Box marginTop={3}>
            <LogoMark height={logoHeight} />
            <Box flexDirection="column" marginLeft={2}>
              <Text>
                <Text color={COLORS.WHITE} bold>WELCOME TO </Text>
                <Text color={COLORS.BLUE_CONTENT} bold>FORTYTWO</Text>
              </Text>
              <Text color={COLORS.WHITE} bold>NODERUNNER</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.BLUE_CONTENT} bold>{titleText}</Text>
                {screen !== "profile_select" && onboardStep ? (
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
        {screen === "profile_select" && (
          <Box flexDirection="column" marginTop={1}>
            {profileError ? <Text color={COLORS.RED}>{profileError}</Text> : null}
            <ThemeProvider theme={selectTheme}>
              <Select options={profileOptions} onChange={handleProfileSelect} />
            </ThemeProvider>
          </Box>
        )}

        {screen === "onboard" && (
          <Onboard
            initialSetupMode={onboardMode}
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
