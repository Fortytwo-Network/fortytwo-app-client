import { useState } from "react";
import { Box, Text, useApp } from "ink";
import { Select } from "@inkjs/ui";
import { configExists, reloadConfig, get as getConfig } from "./config.js";
import { loadIdentity } from "./identity.js";
import Onboard from "./onboard.js";
import BotScreen from "./bot.js";
import { runDaemon } from "./daemon.js";

const banner = [
  "███████╗ ██████╗ ██████╗ ████████╗██╗   ██╗████████╗██╗    ██╗ ██████╗ ",
  "██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝╚██╗ ██╔╝╚══██╔══╝██║    ██║██╔═══██╗",
  "█████╗  ██║   ██║██████╔╝   ██║    ╚████╔╝    ██║   ██║ █╗ ██║██║   ██║",
  "██╔══╝  ██║   ██║██╔══██╗   ██║     ╚██╔╝     ██║   ██║███╗██║██║   ██║",
  "██║     ╚██████╔╝██║  ██║   ██║      ██║      ██║   ╚███╔███╔╝╚██████╔╝",
  "╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝      ╚═╝      ╚═╝    ╚══╝╚══╝  ╚═════╝ ",
];

const COLOR = "rgb(42, 42, 242)";

const MODE_OPTIONS = [
  { label: "Interactive — live UI with logs", value: "interactive" },
  { label: "Daemon — background, logs to file", value: "daemon" },
];

type Screen = "onboard" | "register" | "mode_select" | "running";

function getInitialScreen(): Screen {
  if (!configExists()) return "onboard";
  const cfg = getConfig();
  if (!cfg.identity_file || !loadIdentity(cfg.identity_file)) return "register";
  return "mode_select";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(getInitialScreen);
  const { exit } = useApp();

  function handleModeSelect(value: string) {
    if (value === "daemon") {
      runDaemon();
      exit();
    } else {
      setScreen("running");
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column">
        {banner.map((line, i) => (
          <Text key={i} color={COLOR} bold>
            {line}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        {screen === "onboard" && (
          <Onboard
            onDone={() => {
              reloadConfig();
              setScreen("mode_select");
            }}
          />
        )}

        {screen === "register" && (
          <Onboard
            skipToRegistration
            onDone={() => {
              reloadConfig();
              setScreen("mode_select");
            }}
          />
        )}

        {screen === "mode_select" && (
          <Box flexDirection="column" gap={1}>
            <Text color={COLOR} bold>Select mode</Text>
            <Select options={MODE_OPTIONS} onChange={handleModeSelect} />
          </Box>
        )}

        {screen === "running" && <BotScreen />}
      </Box>
    </Box>
  );
}
