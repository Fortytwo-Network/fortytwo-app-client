import { useState, useCallback, useRef } from "react";
import { Box, Text, Static } from "ink";
import { configExists, reloadConfig, get as getConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import { resetLlmClient } from "./llm.js";
import { COLORS } from "./constants.js";
import Onboard from "./onboard.js";
import BotScreen from "./bot.js";

const LOGO = [
  "    ▒█████░      ▒█████░     █████████░   █████████░",
  "   ▓███████▓    ▓███████▓    █████████░   █████████░",
  "  ░█████████░  ░█████████░   █████████░   █████████░",
  "   ▓███████▓    ▓███████▓    █████████░   █████████░",
  "    ▒█████░      ▒█████░     █████████░   █████████░",
  "                             █████████░   █████████░",
  "    ▒█████░      ▒█████░     █████████░   █████████░",
  "   ▓███████▓    ▓███████▓    █████████░   █████████░",
  "  ░█████████░  ░█████████░   █████████░   █████████░",
  "   ▓███████▓    ▓███████▓    █████████░   █████████░",
  "    ▒█████░      ▒█████░     █████████░   █████████░",
];

type Screen = "onboard" | "register" | "running";

function getInitialScreen(): Screen {
  if (!configExists()) return "onboard";
  const cfg = getConfig();
  if (!cfg.node_identity_file || !loadIdentity(cfg.node_identity_file)) return "register";
  return "running";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const [botKey, setBotKey] = useState(0);

  const handleSwitchProfile = useCallback(() => {
    resetLlmClient();
    setBotKey((k) => k + 1);
  }, []);

  const logoShownRef = useRef(false);
  const showLogo = !logoShownRef.current && screen !== "running";
  if (showLogo) logoShownRef.current = true;

  const fromCreateRef = useRef(false);

  const handleCreateProfile = useCallback(() => {
    fromCreateRef.current = true;
    setScreen("onboard");
  }, []);

  const handleCancelCreate = useCallback(() => {
    fromCreateRef.current = false;
    setScreen("running");
  }, []);

  const handleOnboardDone = useCallback(() => {
    fromCreateRef.current = false;
    reloadConfig();
    resetLlmClient();
    setBotKey((k) => k + 1);
    setScreen("running");
  }, []);

  return (
    <Box flexDirection="column">
      <Static items={showLogo ? ["logo"] : []}>
        {() => (
          <Box flexDirection="column" key="logo-box">
            <Text color={COLORS.BLUE_FRAME} bold>╔═════════ <Text color={COLORS.WHITE} bold>WELCOME TO</Text> <Text color={COLORS.BLUE_CONTENT} bold>FORTYTWO</Text><Text color={COLORS.WHITE} bold>, NETWORK NODE</Text></Text>
            <Text color={COLORS.BLUE_FRAME} bold>║</Text>
            {LOGO.map((line, i) => (
              <Text key={i}><Text color={COLORS.BLUE_FRAME} bold>║</Text> {line}</Text>
            ))}
            <Text color={COLORS.BLUE_FRAME} bold>║</Text>
            <Text color={COLORS.BLUE_FRAME} bold>╚═════════ <Text color={COLORS.WHITE} bold>ONBOARDING</Text></Text>
          </Box>
        )}
      </Static>

      <Box marginTop={screen !== "running" ? 1 : 0}>
        {screen === "onboard" && (
          <Onboard onDone={handleOnboardDone} onCancel={fromCreateRef.current ? handleCancelCreate : undefined} />
        )}

        {screen === "register" && (
          <Onboard skipToRegistration onDone={handleOnboardDone} />
        )}

        {screen === "running" && (
          <BotScreen key={botKey} onSwitchProfile={handleSwitchProfile} onCreateProfile={handleCreateProfile} />
        )}
      </Box>
    </Box>
  );
}
