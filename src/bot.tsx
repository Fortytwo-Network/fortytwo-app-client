import { useState, useEffect, useCallback } from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";
import { CommandInput } from "./command-input.js";
import { get as getConfig } from "./config.js";
import { COLORS } from "./constants.js";
import { setLogFn, setVerbose, log, sleep, getPinnedTasks, formatNumber, truncateName, getRoleLabel } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import { loadIdentity, resetAccount, reactivateAccount } from "./identity.js";
import { runCycle, checkBalance, InsufficientFundsError, initViewerBus } from "./main.js";
import { getLlmStats } from "./llm.js";
import { executeCommand, SUGGESTIONS } from "./commands.js";
import { validateConfig, validateModel } from "./setup-logic.js";
import { viewerBus } from "./event-bus.js";
import { checkForUpdate, UPDATE_COMMAND } from "./update-check.js";

import pkg from "../package.json" with { type: "json" };

type AgentStats = {
  queries: number;
  queriesCompleted: number;
  answers: number;
  answersWon: number;
  winRate: number;
  judgments: number;
  judgmentsWon: number;
  accuracy: number;
};

type AgentProfile = {
  intelligenceScore: number;
  judgingScore: number;
};

const VERSION = pkg.version;

const LOGO = [
  "  ▒██▓░   ▒██▓░   ░████▓░ ░████▓░",
  " ░████▓░ ░████▓░  ░████▓░ ░████▓░",
  "  ▒██▓░   ▒██▓░   ░████▓░ ░████▓░",
  "                  ░████▓░ ░████▓░",
  "  ▒██▓░   ▒██▓░   ░████▓░ ░████▓░",
  " ░████▓░ ░████▓░  ░████▓░ ░████▓░",
  "  ▒██▓░   ▒██▓░   ░████▓░ ░████▓░",
];

const MAX_LINES = 200;
// frame header(1) + empty(1) + logo(7) + empty(1) + frame footer(1) + gap(1) + separator(1) + prompt+footer(1) + gaps
const CHROME_LINES = 14;

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

interface BotScreenProps {
  onSwitchProfile?: () => void;
  onCreateProfile?: () => void;
}

export default function BotScreen({ onSwitchProfile, onCreateProfile }: BotScreenProps = {}) {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("Agent");
  const [agentRole, setAgentRole] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [staked, setStaked] = useState<number | null>(null);
  const [llmActive, setLlmActive] = useState(0);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const { stdout } = useStdout();

  const [termSize, setTermSize] = useState({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });

  useEffect(() => {
    const onResize = () => setTermSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const termCols = termSize.cols;
  const termRows = termSize.rows;
  const visibleCount = Math.max(termRows - CHROME_LINES, 5);

  const pushLine = useCallback((msg: string) => {
    setLines((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  const [client, setClient] = useState<FortyTwoClient | null>(null);

  const handleCommand = useCallback((input: string) => {
    const raw = input.trim();
    if (!raw) return;

    pushLine(" ");
    
    const styledInput = chalk.bgHex(COLORS.BLUE_UNDERLINE)(`${chalk.hex(COLORS.GREY_NEUTRAL)(" ❯ ")}${chalk.hex(COLORS.WHITE)(raw)} `);
    pushLine(styledInput);
    
    pushLine(" ");

    const stripped = raw.startsWith("/") ? raw.slice(1) : raw;

    if (stripped.startsWith("ask ") || stripped === "ask") {
      const question = stripped.slice(4).trim();
      if (!question) {
        pushLine("Usage: /ask <question>");
        return;
      }
      if (!client) {
        pushLine("Not connected yet, wait for login.");
        return;
      }
      pushLine(`Submitting question...`);
      const encrypted = Buffer.from(question, "utf-8").toString("base64");
      client.createQuery(encrypted, "general")
        .then((res) => pushLine(`✓ Question submitted! ID: ${res.id ?? "?"}`))
        .catch((err) => pushLine(`✕ Error: ${err}`));
      return;
    }

    const results = executeCommand(raw);
    let switching = false;
    let creating = false;
    for (const line of results) {
      if (line.startsWith("__SWITCH_PROFILE__:")) {
        switching = true;
        continue;
      }
      if (line === "__CREATE_PROFILE__") {
        creating = true;
        continue;
      }
      pushLine(line);
    }
    pushLine(" ");
    if (switching && onSwitchProfile) {
      onSwitchProfile();
    }
    if (creating && onCreateProfile) {
      onCreateProfile();
    }
  }, [pushLine, client, onSwitchProfile, onCreateProfile]);


  // Balance + stats + profile ticker — every 30s
  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const [balanceData, rawStats, agentData] = await Promise.all([
          client.getBalance().catch(() => null),
          client.getAgentStats().catch(() => null),
          client.getAgent().catch(() => null),
        ]);
        if (cancelled) return;

        if (balanceData) {
          setBalance(parseFloat(balanceData.available ?? "0"));
          setStaked(parseFloat(balanceData.staked ?? "0"));
        }
        if (rawStats) {
          setStats({
            queries: rawStats.queries_submitted ?? 0,
            queriesCompleted: rawStats.queries_completed ?? 0,
            answers: rawStats.answers_submitted ?? 0,
            answersWon: rawStats.answers_won ?? 0,
            winRate: parseFloat(rawStats.answer_win_rate ?? "0"),
            judgments: rawStats.judgments_made ?? 0,
            judgmentsWon: rawStats.judgments_won ?? 0,
            accuracy: parseFloat(rawStats.judgment_accuracy ?? "0"),
          });
        }
        if (agentData) {
          const p = agentData.profile ?? agentData;
          setProfile({
            intelligenceScore: parseFloat(p.intelligence_score ?? p.intellect_score ?? "0"),
            judgingScore: parseFloat(p.judging_score ?? p.judge_score ?? "0"),
          });
        }
      } catch { /* ignore */ }
    };

    tick();
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [client]);

  // LLM stats + pinned tasks ticker — every 1s
  useEffect(() => {
    const id = setInterval(() => {
      setLlmActive(getLlmStats().active);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Update check — fire-and-forget on mount
  useEffect(() => {
    checkForUpdate().then(info => {
      if (info?.updateAvailable) {
        pushLine(chalk.red(`⚠ Your version v${info.currentVersion} is outdated! Latest: v${info.latestVersion}`));
        pushLine(chalk.red(`  Run: ${UPDATE_COMMAND}`));
      }
    }).catch(() => {});
  }, [pushLine]);

  // Main bot loop
  useEffect(() => {
    setLogFn(pushLine);
    if (process.argv.includes("--verbose") || process.argv.includes("-v")) {
      setVerbose(true);
    }

    let cancelled = false;

    (async () => {
      try {
        const cfg = getConfig();
        const identity = loadIdentity(cfg.identity_file);
        if (!identity) {
          setError("No identity found. Run onboarding first.");
          return;
        }

        // Validate config before proceeding
        const cfgCheck = validateConfig(cfg as unknown as Record<string, string>);
        if (!cfgCheck.ok) {
          setError(`Config error: ${cfgCheck.error}`);
          return;
        }

        log("Validating model...");
        const modelCheck = await validateModel(cfg as unknown as Record<string, string>);
        if (!modelCheck.ok) {
          setError(`Config error: ${modelCheck.error}`);
          return;
        }
        log("✓ Configuration valid");

        viewerBus.setState("AUTHENTICATING");
        const c = new FortyTwoClient();
        await c.login(identity.agent_id, identity.secret);
        setClient(c);

        const name = cfg.agent_name || cfg.display_name || "Agent";
        setAgentName(name);
        setAgentRole(cfg.bot_role);
        log(`Logged in as ${name} — ${identity.agent_id}`);
        log(`Role: ${getRoleLabel(cfg.bot_role)} | Poll: ${cfg.poll_interval}s | Model: ${cfg.llm_model}`);

        await initViewerBus(c, cfg, identity.agent_id);

        let cycles = 0;
        while (!cancelled) {
          const cycleStart = Date.now();
          try {
            const available = await checkBalance(c);
            if (!cancelled) setBalance(available);
            if (available < cfg.min_balance) {
              throw new InsufficientFundsError(
                `Insufficient FOR balance: ${available.toFixed(2)} available, ${cfg.min_balance.toFixed(2)} required`,
              );
            }

            const count = await runCycle(c);
            cycles++;
            viewerBus.updateStats({ cycles });
            if (count > 0) log(`✓ Processed ${count} items this cycle`);
          } catch (err) {
            if (cancelled) return;
            if (err instanceof InsufficientFundsError) {
              log(`✕ ${err.message} — resetting account...`);
              viewerBus.pushError(err.message);
              await resetAccount(c, pushLine);
              log("✓ Account reset complete!");
              continue;
            }
            const errMsg = (err as Error).message ?? String(err);
            if (errMsg.toLowerCase().includes("inactive") || errMsg.toLowerCase().includes("deactivated")) {
              log(`Account deactivated — reactivating...`);
              viewerBus.updateStats({ accountInactive: true });
              await reactivateAccount(c, identity.agent_id, identity.secret);
              await c.login(identity.agent_id, identity.secret);
              viewerBus.updateStats({ accountInactive: false });
              log("✓ Reactivation complete!");
              continue;
            }
            log(`✕ Error in cycle: ${err}`);
            viewerBus.pushError(errMsg);
          }

          if (cancelled) return;
          viewerBus.setState("COOLDOWN");
          const elapsed = Date.now() - cycleStart;
          const delay = cfg.poll_interval * 1000 - elapsed;
          if (delay > 0) {
            const totalSec = Math.round(delay / 1000);
            for (let rem = totalSec; rem > 0; rem--) {
              if (cancelled) return;
              viewerBus.updateStats({ cooldownRemaining: rem });
              await sleep(1000);
            }
            viewerBus.updateStats({ cooldownRemaining: 0 });
          } else {
            log(`Cycle took ${Math.round(elapsed / 1000)}s (> ${cfg.poll_interval}s), starting next immediately`);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          viewerBus.setState("ERROR");
          viewerBus.pushError(String(err));
        }
      } finally {
        viewerBus.setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
      setLogFn(console.log);
    };
  }, []);

  const visible = lines.slice(-visibleCount);
  const last = lines.length - 1;
  const offset = lines.length - visible.length;
  const cfg = getConfig();

  const providerStr = cfg.inference_type === "local"
    ? `Self-hosted ${cfg.llm_api_base.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`
    : "OpenRouter";

  const displayName = truncateName(agentName.toUpperCase());
  const intScore = profile ? formatNumber(profile.intelligenceScore, 4) : "—";
  const jdgScore = profile ? formatNumber(profile.judgingScore, 3) : "—";

  const roleDisplay = getRoleLabel(agentRole || cfg.bot_role);

  const qStr = stats ? formatNumber(stats.queries) : "—";
  const finStr = stats ? formatNumber(stats.queriesCompleted) : "—";
  const aStr = stats ? formatNumber(stats.answers) : "—";
  const aWonStr = stats ? formatNumber(stats.answersWon) : "—";
  const aRateStr = stats ? `${Math.round(stats.winRate)}%` : "—";
  const jStr = stats ? formatNumber(stats.judgments) : "—";
  const jWonStr = stats ? formatNumber(stats.judgmentsWon) : "—";
  const jRateStr = stats ? `${Math.round(stats.accuracy)}%` : "—";
  const balStr = balance !== null ? formatNumber(balance) : "—";
  const stakedStr = staked !== null ? formatNumber(staked) : "—";

  const versionText = ` App Fortytwo Client v${VERSION} ──`;
  const centerMarker = " ::|| ";
  const leftDashes = Math.floor((termCols - centerMarker.length) / 2);
  const rightTotal = termCols - leftDashes - centerMarker.length;
  const rightDashes = Math.max(0, rightTotal - versionText.length);
  const topSep = "─".repeat(termCols);

  return (
    <Box flexDirection="column">
      <Text color={COLORS.BLUE_FRAME} bold>╔═════════ <Text color={COLORS.WHITE} bold>{displayName}</Text> <Text color={COLORS.GREY_LIGHT}><Text color={COLORS.BLUE_CONTENT}>·</Text> INT {intScore} <Text color={COLORS.BLUE_CONTENT}>·</Text> JDG {jdgScore}</Text></Text>
      <Text color={COLORS.BLUE_FRAME} bold>║</Text>
      <Box>
        <Box flexDirection="column">
          {LOGO.map((line, i) => (
            <Text key={i}><Text color={COLORS.BLUE_FRAME} bold>║</Text> {line}</Text>
          ))}
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          <Text color={COLORS.BLUE_CONTENT}>{providerStr}</Text>
          <Text color={COLORS.GREY_LIGHT}>{cfg.llm_model}</Text>
          <Text><Text color={COLORS.BLUE_CONTENT}>Poll</Text> <Text color={COLORS.GREY_LIGHT}>{cfg.poll_interval}s</Text> <Text color={COLORS.GREY_LIGHT}>·</Text> <Text color={COLORS.BLUE_CONTENT}>Concurrency</Text> <Text color={COLORS.GREY_LIGHT}>{llmActive}/{cfg.llm_concurrency}</Text></Text>
          <Text><Text color={COLORS.GREY_LIGHT}>{padRight(`Q ${qStr}`, 14)}{padRight(`fin ${finStr}`, 14)}</Text></Text>
          <Text><Text color={COLORS.GREY_LIGHT}>{padRight(`A ${aStr}`, 14)}{padRight(`won ${aWonStr}`, 14)}{`rate ${aRateStr}`}</Text></Text>
          <Text><Text color={COLORS.GREY_LIGHT}>{padRight(`J ${jStr}`, 14)}{padRight(`won ${jWonStr}`, 14)}{`rate ${jRateStr}`}</Text></Text>
          <Text><Text color={COLORS.BLUE_CONTENT} bold>FOR</Text> <Text bold>{balStr}</Text>  <Text color={COLORS.GREY_LIGHT}>staked <Text color={COLORS.WHITE}>{stakedStr}</Text></Text></Text>
        </Box>
      </Box>

      <Text color={COLORS.BLUE_FRAME} bold>║</Text>
      <Text color={COLORS.BLUE_FRAME}>╚═════════ <Text color={COLORS.WHITE}>{roleDisplay} <Text color={COLORS.BLUE_CONTENT}>| WATCH YOUR NODE:</Text> <Text color={COLORS.WHITE}>http://127.0.0.1:4242</Text></Text></Text>
      <Box flexDirection="column" height={visibleCount}>
        {visible.map((line, i) => {
          const globalIdx = offset + i;
          const isCurrent = globalIdx === last && line.trim() !== "";
          return (
            <Text key={globalIdx} color={isCurrent ? COLORS.WHITE : COLORS.GREY_NEUTRAL} wrap="truncate-end">
              {isCurrent ? "▸ " : "  "}{line}
            </Text>
          );
        })}
      </Box>

      {error && <Text color={COLORS.RED}>✕ ERROR: {error}</Text>}

      <Text color={COLORS.GREY_DARK}>{topSep}</Text>

      <Box>
        <Text color={COLORS.WHITE} bold> ❯ </Text>
        <CommandInput placeholder="type help" suggestions={SUGGESTIONS} onSubmit={handleCommand} />
      </Box>

      <Text>
        <Text color={COLORS.GREY_DARK}>{"─".repeat(leftDashes)}</Text>
        <Text color={COLORS.WHITE}>{centerMarker}</Text>
        <Text color={COLORS.GREY_DARK}>{"─".repeat(rightDashes)}{versionText}</Text>
      </Text>
    </Box>
  );
}
