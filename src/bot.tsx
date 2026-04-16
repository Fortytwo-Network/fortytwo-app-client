import { useState, useEffect, useCallback } from "react";
import { Box, Text, useStdout } from "ink";
import chalk from "chalk";
import { CommandInput } from "./command-input.js";
import { get as getConfig } from "./config.js";
import { COLORS } from "./constants.js";
import { setLogFn, setVerbose, log, sleep, formatNumber, truncateName, getRoleLabel } from "./utils.js";
import { FortyTwoClient, ApiError } from "./api-client.js";
import { loadIdentity } from "./identity.js";
import { runCycle, checkBalance, fetchCapability, initViewerBus } from "./main.js";
import { createChallengeContext, LlmFailureError } from "./capability-challenge.js";
import { pingLlm } from "./llm.js";
import { getLlmStats } from "./llm.js";
import { executeCommand, SUGGESTIONS } from "./commands.js";
import { validateConfig, validateModel } from "./setup-logic.js";
import { viewerBus } from "./event-bus.js";
import { checkForUpdate, UPDATE_COMMAND } from "./update-check.js";
import { LogoMark, LOGO_DOT_FRAME_COUNT } from "./logo-mark.js";

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

const MAX_LINES = 200;
// Header + metrics + separator + prompt + footer.
const CHROME_LINES = 16;

function formatCapabilityRank(value: number | null): string {
  if (value === null) return "—";
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, "");
}

function buildCapabilityBar(value: number | null, total = 42): string {
  if (value === null) return `[${"·".repeat(total)}]`;

  const clamped = Math.max(0, Math.min(value, total));
  const full = Math.floor(clamped);
  const fractional = clamped - full;
  const partial = fractional <= 0
    ? ""
    : fractional <= 0.5
      ? "░"
      : "▒";
  const empty = Math.max(0, total - full - (partial ? 1 : 0));
  return `[${"█".repeat(full)}${partial}${"·".repeat(empty)}]`;
}

function fitLine(base: string, termCols: number, reserve = 0): string {
  const max = Math.max(10, termCols - reserve);
  if (base.length <= max) return base;
  if (max <= 3) return base.slice(0, max);
  return `${base.slice(0, max - 3)}...`;
}

function padCell(label: string, value: string, width: number): string {
  const cell = `${label} ${value}`;
  return cell.length >= width ? `${cell} ` : `${cell}${" ".repeat(width - cell.length)}`;
}

function makeColumnParts(
  left: string,
  right: string,
  totalWidth: number,
  leftWidth: number,
): { left: string; right: string } {
  const safeTotal = Math.max(20, totalWidth);
  const safeLeft = Math.max(10, Math.min(leftWidth, safeTotal - 6));
  const safeRight = Math.max(5, safeTotal - safeLeft - 1);

  const leftPart = fitLine(left, safeLeft);
  const rightPart = fitLine(right, safeRight);
  const gap = Math.max(1, safeLeft - leftPart.length + 1);
  return { left: `${leftPart}${" ".repeat(gap)}`, right: rightPart };
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
  const [challengeLocked, setChallengeLocked] = useState<number | null>(null);
  const [capabilityRank, setCapabilityRank] = useState<number | null>(null);
  const [nodeTier, setNodeTier] = useState<"challenger" | "capable" | null>(null);
  const [deadLocked, setDeadLocked] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<"RUNNING" | "STOPPED">("STOPPED");
  const [activeDot, setActiveDot] = useState(-1);
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

  useEffect(() => {
    if (runtimeStatus !== "RUNNING") {
      setActiveDot(-1);
      return;
    }

    setActiveDot(0);
    const id = setInterval(() => {
      setActiveDot((prev) => (prev + 1) % LOGO_DOT_FRAME_COUNT);
    }, 230);
    return () => clearInterval(id);
  }, [runtimeStatus]);

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
      if (nodeTier && nodeTier !== "capable") {
        pushLine(
          `✕ You are still a Challenger${
            capabilityRank !== null ? ` (${capabilityRank}/42)` : ""
          }. Reach Capability 42 by answering challenges first.`,
        );
        return;
      }
      pushLine(`Submitting question...`);
      const encrypted = Buffer.from(question, "utf-8").toString("base64");
      client.createQuery(encrypted, "general")
        .then((res) => pushLine(`✓ Question submitted! ID: ${res.id ?? "?"}`))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 403) {
            pushLine(
              "✕ Challenger nodes cannot create queries. Reach Capability 42 first.",
            );
          } else {
            pushLine(`✕ Error: ${err}`);
          }
        });
      return;
    }

    if (stripped === "capability" || stripped === "capability show") {
      if (!client) { pushLine("Not connected yet, wait for login."); return; }
      client.getCapability(client.nodeId)
        .then((cap) => {
          pushLine(`Node tier:   ${cap.node_tier}`);
          pushLine(`Capability:  ${cap.capability_rank}/42`);
          pushLine(`Dead locked: ${cap.is_dead_locked ? "yes" : "no"}`);
        })
        .catch((err) => pushLine(`✕ Error: ${err}`));
      return;
    }

    if (stripped === "capability history") {
      if (!client) { pushLine("Not connected yet, wait for login."); return; }
      client.getCapabilityHistory(client.nodeId, 1, 10)
        .then((history) => {
          if (history.items.length === 0) {
            pushLine("No capability changes recorded.");
            return;
          }
          pushLine(`Capability history (${history.total} total, showing last ${history.items.length}):`);
          for (const e of history.items) {
            const sign = e.delta > 0 ? "+" : "";
            pushLine(`  ${e.created_at}  ${sign}${e.delta}  ${e.rank_before}→${e.rank_after}  ${e.reason}`);
          }
        })
        .catch((err) => pushLine(`✕ Error: ${err}`));
      return;
    }

    if (stripped === "challenge" || stripped === "challenge list") {
      if (!client) { pushLine("Not connected yet, wait for login."); return; }
      client.listActiveChallengeRounds(1, 50)
        .then((page) => {
          if (page.items.length === 0) {
            pushLine("No active challenge rounds.");
            return;
          }
          pushLine(`Active challenge rounds (${page.items.length}):`);
          for (const r of page.items) {
            const slots = `${r.joined_count}/${r.max_participants} joined`;
            let tag = "";
            if (r.slots_remaining <= 0) tag = " [full]";
            else if (r.has_answered) tag = " [answered]";
            else if (r.has_joined) tag = " [joined]";
            pushLine(`  ${r.id}  ends ${r.ends_at}  ${r.for_budget_total} FOR  ${slots}${tag}`);
          }
        })
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
  }, [pushLine, client, onSwitchProfile, onCreateProfile, nodeTier, capabilityRank]);


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
          setChallengeLocked(parseFloat(balanceData.challenge_locked ?? "0"));
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
          if (agentData.capability_rank !== undefined) {
            setCapabilityRank(Number(agentData.capability_rank));
          }
          if (agentData.node_tier) {
            setNodeTier(agentData.node_tier);
          }
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
        const identity = loadIdentity(cfg.node_identity_file);
        if (!identity) {
          setRuntimeStatus("STOPPED");
          setError("No identity found. Run onboarding first.");
          return;
        }

        // Validate config before proceeding
        const cfgCheck = validateConfig(cfg as unknown as Record<string, string>);
        if (!cfgCheck.ok) {
          setRuntimeStatus("STOPPED");
          setError(`Config error: ${cfgCheck.error}`);
          return;
        }

        const modelCheck = await validateModel(cfg as unknown as Record<string, string>);
        if (!modelCheck.ok) {
          setRuntimeStatus("STOPPED");
          setError(`Config error: ${modelCheck.error}`);
          return;
        }

        viewerBus.setState("AUTHENTICATING");
        const c = new FortyTwoClient();
        await c.login(identity.node_id, identity.node_secret);
        setClient(c);
        setRuntimeStatus("RUNNING");

        const name = cfg.node_name || cfg.node_display_name || "Agent";
        setAgentName(name);
        setAgentRole(cfg.node_role);
        log(`Logged in as ${name} — ${identity.node_id}`);
        log(`Role: ${getRoleLabel(cfg.node_role)} | Poll: ${cfg.poll_interval}s | Model: ${cfg.model_name}`);

        await initViewerBus(c, cfg, identity.node_id);

        const challengeCtx = createChallengeContext(c);
        let cycles = 0;
        // Inference-down guard: skip cycles until a cheap ping succeeds.
        let inferenceDown = false;
        while (!cancelled) {
          const cycleStart = Date.now();
          try {
            if (inferenceDown) {
              log("Inference was down — probing with ping...");
              if (await pingLlm()) {
                log("✓ Inference restored, resuming work");
                inferenceDown = false;
                setRuntimeStatus("RUNNING");
              } else {
                log("✕ Inference still unavailable — skipping cycle");
                setRuntimeStatus("STOPPED");
              }
            }

            if (!inferenceDown) {
              setRuntimeStatus("RUNNING");
              const available = await checkBalance(c);
              if (!cancelled) setBalance(available);
              const capability = await fetchCapability(c);
              if (!cancelled && capability) {
                setCapabilityRank(capability.capability_rank);
                setNodeTier(capability.node_tier);
                setDeadLocked(capability.is_dead_locked);
              }

              // `min_balance` gates Capable nodes only. Challengers are funded
              // from `challenge_locked`, so a zero `available` is expected.
              if (capability.node_tier === "capable" && available < cfg.min_balance) {
                const msg = `Low balance: ${available.toFixed(2)} FOR < ${cfg.min_balance.toFixed(2)} required. Worker idle — run 'fortytwo reset --yes' manually.`;
                log(`⚠ ${msg}`);
                viewerBus.pushError(msg);
              } else {
                const count = await runCycle(c, capability, challengeCtx);
                cycles++;
                viewerBus.updateStats({ cycles });
                if (count > 0) log(`✓ Processed ${count} items this cycle`);
              }
            }
          } catch (err) {
            if (cancelled) return;
            const errMsg = (err as Error).message ?? String(err);
            if (err instanceof LlmFailureError) {
              inferenceDown = true;
              setRuntimeStatus("STOPPED");
              log(`⚠ Inference unavailable — pausing until ping succeeds. (${errMsg})`);
              viewerBus.pushError(`Inference unavailable: ${errMsg}`);
            } else {
              setRuntimeStatus("STOPPED");
              log(`✕ Error in cycle: ${err}`);
              viewerBus.pushError(errMsg);
            }
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
          setRuntimeStatus("STOPPED");
          setError(String(err));
          viewerBus.setState("ERROR");
          viewerBus.pushError(String(err));
        }
      } finally {
        setRuntimeStatus("STOPPED");
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

  const providerStr = cfg.inference_type === "self-hosted"
    ? `Self-hosted ${cfg.self_hosted_api_base.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`
    : "OpenRouter";

  const displayName = truncateName(agentName.toUpperCase(), 44);
  const intScore = profile ? formatNumber(profile.intelligenceScore, 4) : "—";
  const jdgScore = profile ? formatNumber(profile.judgingScore, 3) : "—";

  const roleDisplay = getRoleLabel(agentRole || cfg.node_role);

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
  const panelWidth = Math.max(40, termCols - 8);
  const columnLeftWidth = Math.min(40, Math.max(28, Math.floor(panelWidth * 0.55)));
  const capRankValue = formatCapabilityRank(capabilityRank);
  const capRankSuffix = "/42";
  const capRankStr = `${capRankValue}${capRankSuffix}`;
  const capBar = buildCapabilityBar(capabilityRank, 42);
  const headerDisplay = fitLine(`${displayName} · ${roleDisplay}`, panelWidth);
  const tierTitle = nodeTier === "capable"
    ? "CAPABLE TIER"
    : nodeTier === "challenger"
      ? "CHALLENGER TIER"
      : "NODE TIER";
  const tierDetail = nodeTier === "capable"
    ? `INT ${intScore} · JDG ${jdgScore}`
    : nodeTier === "challenger"
      ? "PASS CAPABILITY CHALLENGE, UNLOCK FULL FUNCTIONALITY"
      : "INITIALIZING";
  const tierColor = nodeTier === "capable" ? COLORS.WHITE : COLORS.GREY_LIGHT;
  const tierTitleColor = nodeTier === "capable" ? COLORS.BLUE_CONTENT : COLORS.WHITE;
  const statusTag = runtimeStatus === "STOPPED" ? "STOPPED" : "";
  const leftQ = `${padCell("Q", qStr, 12)}${padCell("fin", finStr, 12)}`;
  const leftA = `${padCell("A", aStr, 12)}${padCell("won", aWonStr, 12)}rate ${aRateStr}`;
  const leftJ = `${padCell("J", jStr, 12)}${padCell("won", jWonStr, 12)}rate ${jRateStr}`;
  const scoreLine1 = makeColumnParts(leftQ, providerStr, panelWidth, columnLeftWidth);
  const scoreLine2 = makeColumnParts(leftA, cfg.model_name, panelWidth, columnLeftWidth);
  const scoreLine3 = makeColumnParts(
    leftJ,
    `Poll ${cfg.poll_interval}s  Concurrency ${llmActive}/${cfg.llm_concurrency}`,
    panelWidth,
    columnLeftWidth,
  );
  const capBarDisplay = fitLine(
    capBar,
    panelWidth - (statusTag ? statusTag.length + 1 : 0) - capRankStr.length - 1,
  );
  const watchUrl = "http://127.0.0.1:4242/";

  const versionText = ` Node Fortytwo v${VERSION} ──`;
  const leftDashes = Math.floor((termCols) / 2);
  const rightTotal = termCols - leftDashes;
  const rightDashes = Math.max(0, rightTotal - versionText.length);
  const topSep = "─".repeat(termCols);

  return (
    <Box flexDirection="column">
      <Box>
        <LogoMark tier={nodeTier} activeDot={activeDot} height={10} />
        <Box flexDirection="column" marginLeft={1}>
          <Text bold wrap="truncate-end">
            {(() => {
              const dot = " · ";
              const dotIdx = headerDisplay.indexOf(dot);
              if (dotIdx < 0) {
                return <Text color={COLORS.WHITE}>{headerDisplay}</Text>;
              }
              const left = headerDisplay.slice(0, dotIdx);
              const right = headerDisplay.slice(dotIdx + dot.length);
              return (
                <>
                  <Text color={COLORS.WHITE}>{left}</Text>
                  <Text color={COLORS.BLUE_FRAME}>{dot}</Text>
                  <Text color={COLORS.WHITE}>{right}</Text>
                </>
              );
            })()}
          </Text>
          <Text wrap="truncate-end">
            <Text color={tierTitleColor} bold>{tierTitle}</Text>
            <Text color={COLORS.BLUE_FRAME}> · </Text>
            <Text color={tierColor}>{fitLine(tierDetail, panelWidth - tierTitle.length - 3)}</Text>
          </Text>
          <Text wrap="truncate-end">
            {statusTag ? <Text color={COLORS.RED}>{statusTag} </Text> : null}
            <Text color={COLORS.BLUE_FRAME}>{capBarDisplay}</Text>
            <Text color={COLORS.WHITE}> {capRankValue}</Text>
            <Text color={COLORS.GREY_LIGHT}>{capRankSuffix}</Text>
          </Text>
          <Text> </Text>
          <Text wrap="truncate-end">
            <Text color={COLORS.GREY_LIGHT}>{scoreLine1.left}</Text>
            {(() => {
              const parsed = scoreLine1.right.match(/^(Self-hosted)\s+(.+)$/);
              if (!parsed) {
                return <Text color={COLORS.BLUE_FRAME}>{scoreLine1.right}</Text>;
              }
              return (
                <>
                  <Text color={COLORS.BLUE_FRAME}>{parsed[1]} </Text>
                  <Text color={COLORS.GREY_LIGHT}>{parsed[2]}</Text>
                </>
              );
            })()}
          </Text>
          <Text wrap="truncate-end">
            <Text color={COLORS.GREY_LIGHT}>{scoreLine2.left}</Text>
            <Text color={COLORS.GREY_LIGHT}>{scoreLine2.right}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color={COLORS.GREY_LIGHT}>{scoreLine3.left}</Text>
            {(() => {
              const parsed = scoreLine3.right.match(/^Poll\s+(\S+)\s+Concurrency\s+(\S+)$/);
              if (!parsed) {
                return <Text color={COLORS.BLUE_FRAME}>{scoreLine3.right}</Text>;
              }
              return (
                <>
                  <Text color={COLORS.BLUE_FRAME}>Poll </Text>
                  <Text color={COLORS.GREY_LIGHT}>{parsed[1]}</Text>
                  <Text color={COLORS.BLUE_FRAME}>  Concurrency </Text>
                  <Text color={COLORS.GREY_LIGHT}>{parsed[2]}</Text>
                </>
              );
            })()}
          </Text>
          <Text> </Text>
          <Text wrap="truncate-end">
            <Text color={COLORS.BLUE_FRAME} bold>FOR</Text>
            <Text color={COLORS.WHITE}> {balStr}</Text>
            <Text color={COLORS.GREY_LIGHT}> staked</Text>
            <Text color={COLORS.WHITE}> {stakedStr}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color={COLORS.BLUE_FRAME}>WATCH YOUR NODE:</Text>
            <Text color={COLORS.WHITE}> {watchUrl}</Text>
          </Text>
          <Text color={COLORS.GREY_DARK} wrap="truncate-end">{fitLine("", panelWidth)}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" height={visibleCount} marginTop={1}>
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

      {deadLocked && (
        <Text color={COLORS.RED}>⚠ Dead lock — no FOR available. Run: fortytwo reset (to get 250 FOR drop)</Text>
      )}

      {error && <Text color={COLORS.RED}>✕ ERROR: {error}</Text>}

      <Text color={COLORS.GREY_DARK}>{topSep}</Text>

      <Box>
        <Text color={COLORS.WHITE} bold> ❯ </Text>
        <CommandInput placeholder="type help" suggestions={SUGGESTIONS} onSubmit={handleCommand} />
      </Box>

      <Text>
        <Text color={COLORS.GREY_DARK}>{"─".repeat(leftDashes)}</Text>
        <Text color={COLORS.GREY_DARK}>{"─".repeat(rightDashes)}{versionText}</Text>
      </Text>
    </Box>
  );
}
