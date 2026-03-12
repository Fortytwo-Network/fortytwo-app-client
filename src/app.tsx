import { useState } from "react";
import { Box, Text } from "ink";
import { configExists, reloadConfig, get as getConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
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
  if (!cfg.identity_file || !loadIdentity(cfg.identity_file)) return "register";
  return "running";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(getInitialScreen);

  return (
    <Box flexDirection="column">
      {screen !== "running" && (
        <Box flexDirection="column">
          <Text color={COLORS.BLUE_FRAME} bold>╔═════════ <Text color={COLORS.WHITE} bold>WELCOME TO</Text> <Text color={COLORS.BLUE_CONTENT} bold>FORTYTWO</Text><Text color={COLORS.WHITE} bold>, SWARM AGENT</Text></Text>
          <Text color={COLORS.BLUE_FRAME} bold>║</Text>
          {LOGO.map((line, i) => (
            <Text key={i}><Text color={COLORS.BLUE_FRAME} bold>║</Text> {line}</Text>
          ))}
          <Text color={COLORS.BLUE_FRAME} bold>║</Text>
          <Text color={COLORS.BLUE_FRAME} bold>╚═════════ <Text color={COLORS.WHITE} bold>ONBOARDING</Text></Text>
        </Box>
      )}

      <Box marginTop={screen !== "running" ? 1 : 0}>
        {screen === "onboard" && (
          <Onboard
            onDone={() => {
              reloadConfig();
              setScreen("running");
            }}
          />
        )}

        {screen === "register" && (
          <Onboard
            skipToRegistration
            onDone={() => {
              reloadConfig();
              setScreen("running");
            }}
          />
        )}

        {screen === "running" && <BotScreen />}
      </Box>
    </Box>
  );
}
