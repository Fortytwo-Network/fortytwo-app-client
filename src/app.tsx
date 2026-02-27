import { useState } from "react";
import { Box, Text } from "ink";
import { configExists, reloadConfig, get as getConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import Onboard from "./onboard.js";
import BotScreen from "./bot.js";

const banner = [
  "███████╗ ██████╗ ██████╗ ████████╗██╗   ██╗████████╗██╗    ██╗ ██████╗ ",
  "██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝╚██╗ ██╔╝╚══██╔══╝██║    ██║██╔═══██╗",
  "█████╗  ██║   ██║██████╔╝   ██║    ╚████╔╝    ██║   ██║ █╗ ██║██║   ██║",
  "██╔══╝  ██║   ██║██╔══██╗   ██║     ╚██╔╝     ██║   ██║███╗██║██║   ██║",
  "██║     ╚██████╔╝██║  ██║   ██║      ██║      ██║   ╚███╔███╔╝╚██████╔╝",
  "╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝      ╚═╝      ╚═╝    ╚══╝╚══╝  ╚═════╝ ",
];

const COLOR = "rgb(42, 42, 242)";

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
    <Box flexDirection="column" padding={1}>
      {screen !== "running" && (
        <Box flexDirection="column">
          {banner.map((line, i) => (
            <Text key={i} color={COLOR} bold>
              {line}
            </Text>
          ))}
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
