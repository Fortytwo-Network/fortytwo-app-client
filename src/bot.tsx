import { useState, useEffect, useCallback } from "react";
import { Box, Text, useStdout } from "ink";
import { CommandInput } from "./command-input.js";
import { get as getConfig } from "./config.js";
import { setLogFn, setVerbose, log, sleep, getPinnedTasks } from "./utils.js";
import type { PinnedTask } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import { loadIdentity } from "./identity.js";
import { runCycle, checkBalance, InsufficientFundsError } from "./main.js";
import { getLlmStats } from "./llm.js";
import { resetAccount } from "./identity.js";
import { executeCommand, SUGGESTIONS } from "./commands.js";

type AgentStats = {
  queries: number;
  queriesCompleted: number;
  answers: number;
  answersWon: number;
  winRate: number;
  judgments: number;
  accuracy: number;
};

const COLOR = "rgb(42, 42, 242)";

const LOGO = [
"██╗██╗  ██╗██╗",
"╚═╝╚═╝  ██║██║",
"██╗██╗  ██║██║",
"╚═╝╚═╝  ╚═╝╚═╝", 
]         

const MAX_LINES = 200;
const MAX_PINNED_LINES = 3;
// padding(2) + logo+stats(3) + tasks(3) + separator(1) + prompt(1) + gaps(4)
const CHROME_LINES = 14;

function formatCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export default function BotScreen() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Starting...");
  const [balance, setBalance] = useState<number | null>(null);
  const [nextPollAt, setNextPollAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const [llmActive, setLlmActive] = useState(0);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [tasks, setTasks] = useState<PinnedTask[]>([]);
  const { stdout } = useStdout();

  const termRows = stdout.rows ?? 24;
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
        .then((res) => pushLine(`Question submitted! ID: ${res.id ?? "?"}`))
        .catch((err) => pushLine(`Error: ${err}`));
      return;
    }

    const results = executeCommand(raw);
    for (const line of results) pushLine(line);
  }, [pushLine, client]);

  // Countdown ticker — updates every second
  useEffect(() => {
    if (nextPollAt === null) {
      setCountdown(null);
      return;
    }
    const tick = () => {
      const remaining = nextPollAt - Date.now();
      if (remaining <= 0) {
        setCountdown(null);
        setNextPollAt(null);
      } else {
        setCountdown(formatCountdown(remaining));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextPollAt]);

  // Balance + stats ticker — every 30s, independent of main cycle
  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const [available, raw] = await Promise.all([
          checkBalance(client),
          client.getAgentStats().catch(() => null),
        ]);
        if (cancelled) return;
        setBalance(available);
        if (raw) {
          setStats({
            queries: raw.queries_submitted ?? 0,
            queriesCompleted: raw.queries_completed ?? 0,
            answers: raw.answers_submitted ?? 0,
            answersWon: raw.answers_won ?? 0,
            winRate: parseFloat(raw.answer_win_rate ?? "0"),
            judgments: raw.judgments_made ?? 0,
            accuracy: parseFloat(raw.judgment_accuracy ?? "0"),
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
      setTasks(getPinnedTasks());
    }, 1000);
    return () => clearInterval(id);
  }, []);

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

        const c = new FortyTwoClient();
        await c.login(identity.agent_id, identity.secret);
        setClient(c);

        const name = cfg.agent_name || cfg.display_name || "Agent";
        setStatus(`${name} | ${cfg.bot_role}`);
        log(`Logged in as ${name} — ${identity.agent_id}`);
        log(`Role: ${cfg.bot_role} | Poll: ${cfg.poll_interval}s | Model: ${cfg.llm_model}`);

        while (!cancelled) {
          setNextPollAt(null);
          const cycleStart = Date.now();
          try {
            const available = await checkBalance(c);
            if (!cancelled) setBalance(available);
            if (available < cfg.min_balance) {
              throw new InsufficientFundsError(
                `Balance ${available.toFixed(2)} FOR < minimum ${cfg.min_balance.toFixed(2)} FOR`,
              );
            }

            const count = await runCycle(c);
            if (count > 0) log(`Processed ${count} items this cycle`);
          } catch (err) {
            if (cancelled) return;
            if (err instanceof InsufficientFundsError) {
              log(`${err.message} — resetting account...`);
              await resetAccount(c, pushLine);
              log("Account reset complete!");
              continue;
            }
            log(`Error in cycle: ${err}`);
          }

          if (cancelled) return;
          const elapsed = Date.now() - cycleStart;
          const delay = cfg.poll_interval * 1000 - elapsed;
          if (delay > 0) {
            setNextPollAt(Date.now() + delay);
            await sleep(delay);
          } else {
            log(`Cycle took ${Math.round(elapsed / 1000)}s (> ${cfg.poll_interval}s), starting next immediately`);
          }
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
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

  const balanceColor = balance !== null && balance < (getConfig().min_balance ?? 5) ? "red" : "green";

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={2}>
        <Box flexDirection="column">
          {LOGO.map((line, i) => (
            <Text key={i} color={COLOR} bold>{line}</Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text color={COLOR} bold>{status}</Text>
          <Text>
            {balance !== null
              ? <Text color={balanceColor} bold>{balance.toFixed(2)} FOR</Text>
              : <Text dimColor>loading...</Text>}
            <Text dimColor> · {getConfig().llm_model}</Text>
            <Text dimColor> · LLM {llmActive}/{getConfig().llm_concurrency}</Text>
          </Text>
          {stats
            ? <Text dimColor>Q: {stats.queries} ({stats.queriesCompleted} done) · A: {stats.answers} ({stats.answersWon} wins) · J: {stats.judgments}{countdown ? ` · ${countdown}` : ""}</Text>
            : <Text dimColor>{countdown ? countdown : "loading stats..."}</Text>}
        </Box>
      </Box>

      <Box flexDirection="column" height={MAX_PINNED_LINES}>
        {tasks.slice(0, MAX_PINNED_LINES).map((t) => (
          <Text key={t.id} color="cyan">
            ● {t.label} ({formatCountdown(Date.now() - t.startedAt)})
          </Text>
        ))}
      </Box>

      <Text dimColor>{"─".repeat(Math.min(stdout.columns ?? 72, 72))}</Text>

      <Box flexDirection="column" height={visibleCount}>
        {visible.map((line, i) => {
          const globalIdx = offset + i;
          const isCurrent = globalIdx === last;
          return (
            <Text key={globalIdx} color={isCurrent ? "yellow" : undefined} dimColor={!isCurrent}>
              {isCurrent ? "▸ " : "  "}{line}
            </Text>
          );
        })}
      </Box>

      {error && <Text color="red">{error}</Text>}

      <Box>
        <Text color={COLOR} bold>{">"} </Text>
        <CommandInput placeholder="type help" suggestions={SUGGESTIONS} onSubmit={handleCommand} />
      </Box>
    </Box>
  );
}
