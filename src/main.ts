import { createHash } from "node:crypto";
import * as config from "./config.js";
import { sleep, secondsUntilDeadline, setVerbose, log, getRoleLabel } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import { loadIdentity, resetAccount, reactivateAccount } from "./identity.js";
import { judgeChallenge } from "./judging.js";
import { answerQuery } from "./answering.js";
import { isLlmBusy } from "./llm.js";
import { validateModel } from "./setup-logic.js";
import { viewerBus, type VisibleQuery } from "./event-bus.js";

/** Initialize viewer dashboard config and load initial stats from API. */
export async function initViewerBus(
  client: FortyTwoClient,
  cfg: ReturnType<typeof config.get>,
  agentId: string,
): Promise<void> {
  viewerBus.setConfig({
    agentId,
    llmModel: cfg.llm_model,
    inferenceType: cfg.inference_type,
    provider: cfg.inference_type === "local"
      ? cfg.llm_api_base.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
      : "OpenRouter",
    cycleIntervalMs: cfg.poll_interval * 1000,
    autoRestart: true,
  });
  viewerBus.setRunning(true);

  try {
    const [rawStats, agentData] = await Promise.all([
      client.getAgentStats().catch(() => null),
      client.getAgent().catch(() => null),
    ]);
    if (rawStats) {
      viewerBus.updateStats({
        answersSubmitted: rawStats.answers_submitted ?? 0,
        answersWon: rawStats.answers_won ?? 0,
        answerWinRate: String(rawStats.answer_win_rate ?? "0"),
        judgmentsMade: rawStats.judgments_made ?? 0,
        judgmentAccuracy: String(rawStats.judgment_accuracy ?? "0"),
        queriesSubmitted: rawStats.queries_submitted ?? 0,
        queriesCompleted: rawStats.queries_completed ?? 0,
      });
    }
    if (agentData) {
      const p = agentData.profile ?? agentData;
      viewerBus.updateStats({
        rank: String(p.intelligence_score ?? p.intellect_score ?? "—"),
        judgeElo: String(p.judging_score ?? p.judge_score ?? "—"),
        intelligenceNormalized: String(p.intelligence_normalized ?? "0"),
        judgingNormalized: String(p.judging_normalized ?? "0"),
      });
    }
  } catch { /* stats are optional — don't block startup */ }
}

export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

function shouldAnswer(queryId: string, agentId: string): boolean {
  const hash = createHash("sha256").update(queryId + agentId).digest("hex");
  return parseInt(hash.slice(-8), 16) % 2 === 0;
}

function answerRemainingSeconds(createdAtStr: string, decisionDeadlineStr: string): number {
  try {
    const createdAt = new Date(createdAtStr.replace("Z", "+00:00"));
    const decisionDeadline = new Date(decisionDeadlineStr.replace("Z", "+00:00"));
    if (isNaN(createdAt.getTime()) || isNaN(decisionDeadline.getTime())) return 0;
    const totalDuration = (decisionDeadline.getTime() - createdAt.getTime()) / 1000;
    const answerDeadline = new Date(createdAt.getTime() + totalDuration * 0.7 * 1000);
    return (answerDeadline.getTime() - Date.now()) / 1000;
  } catch {
    return 0;
  }
}

export async function checkBalance(client: FortyTwoClient): Promise<number> {
  try {
    const balanceData = await client.getBalance();
    const available = parseFloat(balanceData.available ?? "0");
    const staked = parseFloat(balanceData.staked ?? "0");
    const total = parseFloat(balanceData.total ?? "0");
    const weekEarned = parseFloat(balanceData.current_week_earned ?? "0");
    const lifetimeEarned = parseFloat(balanceData.lifetime_earned ?? "0");
    const lifetimeSpent = parseFloat(balanceData.lifetime_spent ?? "0");
    viewerBus.updateStats({
      energy: available,
      staked,
      total,
      weekEarned,
      lifetimeEarned,
      lifetimeSpent,
      forBalance: available.toFixed(2),
    });
    return available;
  } catch (err) {
    log(`Failed to check balance: ${err}`);
    return 0;
  }
}

// Track in-flight task IDs to avoid duplicates across cycles
const inFlight = new Set<string>();

const taskStats = { answering: 0, judging: 0 };

export function getTaskStats() {
  return { ...taskStats };
}

function launchTask(id: string, label: string, fn: () => Promise<void>): void {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  fn()
    .then(() => {
      if (label === "answering") taskStats.answering++;
      else if (label === "judging") taskStats.judging++;
    })
    .catch((err) => log(`[${id.slice(0, 8)}] ${label[0].toUpperCase()}${label.slice(1)} failed: ${(err as Error).message ?? err}`))
    .finally(() => inFlight.delete(id));
}

export async function processChallenges(client: FortyTwoClient, dualMode = false): Promise<number> {
  viewerBus.setState("JUDGING");
  if (isLlmBusy()) {
    log(`LLM queue busy, skipping challenge pickup`);
    return 0;
  }

  const pending = await client.getPendingChallenges(1, 50);
  const challenges = (pending.challenges ?? []) as Record<string, any>[];

  if (challenges.length === 0) {
    log("No pending challenges available");
    return 0;
  }

  const eligible = challenges.filter((ch) => {
    if (ch.has_voted) return false;
    if (inFlight.has(String(ch.id))) return false;
    const queryId = String(ch.query_id ?? "");
    if (dualMode && queryId && shouldAnswer(queryId, client.agentId)) return false;
    const effectiveDeadline = (ch.effective_voting_deadline ?? ch.judging_deadline_at ?? "") as string;
    const remaining = secondsUntilDeadline(effectiveDeadline);
    if (remaining > 0 && remaining < config.MIN_DEADLINE_SECONDS) {
      log(`[${String(ch.id).slice(0, 8)}] ↳ Skipping: only ${Math.round(remaining)}s until deadline`);
      return false;
    }
    return true;
  });

  log(`↳ Found ${challenges.length} pending challenges (${eligible.length} eligible, ${inFlight.size} in-flight)`);

  for (const ch of eligible) {
    const challengeId = String(ch.id);
    const effectiveDeadline = (ch.effective_voting_deadline ?? ch.judging_deadline_at ?? "") as string;
    const remaining = secondsUntilDeadline(effectiveDeadline);
    const answerCount = (ch.answer_count ?? 0) as number;
    launchTask(challengeId, "judging", () =>
      judgeChallenge(client, challengeId, remaining, answerCount),
    );
  }

  return eligible.length;
}

export async function processQueries(client: FortyTwoClient, dualMode = false): Promise<number> {
  viewerBus.setState("SCANNING");
  const resp = await client.getActiveQueries(1, 50);
  const queries = (resp.queries ?? []) as Record<string, any>[];

  const visibleQueries: VisibleQuery[] = queries.map((q) => {
    const queryId = String(q.id);
    const isInFlight = inFlight.has(queryId);
    let status = "available";
    if (isInFlight) status = "active";
    else if (q.has_answered) status = "answered";
    return {
      id: queryId,
      specialization: String(q.specialization ?? "general"),
      stake: parseFloat(q.stake_amount ?? "0"),
      minRank: parseFloat(q.min_intelligence_rank ?? "0"),
      answerCount: (q.answer_count ?? 0) as number,
      status,
      questionText: q.decrypted_content as string | undefined,
    };
  });
  viewerBus.setQueries(visibleQueries);
  viewerBus.updateStats({ questionsAvailable: queries.length });

  if (queries.length === 0) {
    log("No active queries available");
    return 0;
  }

  const eligible = queries.filter((q) => {
    const queryId = String(q.id);
    if (inFlight.has(queryId)) return false;
    if (dualMode && !shouldAnswer(queryId, client.agentId)) return false;
    const createdAtStr = (q.created_at ?? "") as string;
    const decisionDeadlineStr = (q.decision_deadline_at ?? "") as string;
    const answerRemaining = answerRemainingSeconds(createdAtStr, decisionDeadlineStr);
    if (answerRemaining < -300) return false;
    return true;
  });

  log(`↳ Found ${queries.length} active queries (${eligible.length} eligible, ${inFlight.size} in-flight)`);

  for (const q of eligible) {
    launchTask(String(q.id), "answering", () =>
      answerQuery(client, String(q.id)),
    );
  }

  return eligible.length;
}

export async function runCycle(client: FortyTwoClient): Promise<number> {
  const cfg = config.get();
  const role = cfg.bot_role;
  let total = 0;

  if (role === "JUDGE") {
    total += await processChallenges(client, false);
  } else if (role === "ANSWERER") {
    total += await processQueries(client, false);
  } else if (role === "ANSWERER_AND_JUDGE") {
    const [q, c] = await Promise.all([
      processQueries(client, true),
      processChallenges(client, true),
    ]);
    total += q + c;
  } else {
    log(`Unknown BOT_ROLE: ${role}`);
  }

  return total;
}

export async function main(signal?: AbortSignal): Promise<void> {
  const cfg = config.get();
  if (process.argv.includes("--verbose") || process.argv.includes("-v")) {
    setVerbose(true);
  }

  if (cfg.inference_type !== "local" && !cfg.openrouter_api_key) {
    log("OPENROUTER_API_KEY not set. Run onboarding first.");
    process.exit(1);
  }

  const role = cfg.bot_role;
  if (!["JUDGE", "ANSWERER", "ANSWERER_AND_JUDGE"].includes(role)) {
    log(`Invalid BOT_ROLE: ${role}`);
    process.exit(1);
  }

  log(`↳ Bot role: ${getRoleLabel(role)}`);

  const validation = await validateModel({
    inference_type: cfg.inference_type,
    llm_api_base: cfg.llm_api_base,
    openrouter_api_key: cfg.openrouter_api_key,
    llm_model: cfg.llm_model,
  });
  if (!validation.ok) {
    log(`Model check failed: ${validation.error}`);
    process.exit(1);
  }
  log(`✓ Model OK: ${cfg.llm_model}`);

  const client = new FortyTwoClient();

  try {
    const identity = loadIdentity(cfg.identity_file);

    if (!identity) {
      log("No identity found. Run onboarding first.");
      process.exit(1);
    }

    viewerBus.setState("AUTHENTICATING");
    await client.login(identity.agent_id, identity.secret);
    await initViewerBus(client, cfg, identity.agent_id);

    log(`✓ Starting polling loop (interval: ${cfg.poll_interval}s)`);
    let cycles = 0;
    while (!signal?.aborted) {
      const cycleStart = Date.now();
      try {
        const available = await checkBalance(client);
        if (available < cfg.min_balance) {
          throw new InsufficientFundsError(
            `Insufficient FOR balance: ${available.toFixed(2)} available, ${cfg.min_balance.toFixed(2)} required`,
          );
        }

        const count = await runCycle(client);
        cycles++;
        viewerBus.updateStats({ cycles });
        if (count > 0) log(`Processed ${count} items this cycle`);
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof InsufficientFundsError) {
          log(`${err.message} — resetting account...`);
          viewerBus.pushError(err.message);
          await resetAccount(client);
          log("Account reset complete!");
          continue;
        }
        const errMsg = (err as Error).message ?? String(err);
        if (errMsg.toLowerCase().includes("inactive") || errMsg.toLowerCase().includes("deactivated")) {
          log(`Account deactivated — reactivating...`);
          viewerBus.updateStats({ accountInactive: true });
          await reactivateAccount(client, identity.agent_id, identity.secret);
          await client.login(identity.agent_id, identity.secret);
          viewerBus.updateStats({ accountInactive: false });
          log("Reactivation complete!");
          continue;
        }
        log(`Error in polling cycle: ${errMsg}`);
        viewerBus.pushError(errMsg);
      }

      if (signal?.aborted) return;
      viewerBus.setState("COOLDOWN");
      const elapsed = Date.now() - cycleStart;
      const delay = cfg.poll_interval * 1000 - elapsed;
      if (delay > 0) {
        const totalSec = Math.round(delay / 1000);
        for (let rem = totalSec; rem > 0; rem--) {
          viewerBus.updateStats({ cooldownRemaining: rem });
          await sleep(1000, signal);
          if (signal?.aborted) return;
        }
        viewerBus.updateStats({ cooldownRemaining: 0 });
      } else {
        log(`Cycle took ${Math.round(elapsed / 1000)}s (> ${cfg.poll_interval}s), starting next immediately`);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      log(`Fatal error: ${err}`);
      viewerBus.setState("ERROR");
      viewerBus.pushError(String(err));
    }
  } finally {
    viewerBus.setRunning(false);
  }
}
