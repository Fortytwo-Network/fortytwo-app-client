import { createHash } from "node:crypto";
import * as config from "./config.js";
import { sleep, secondsUntilDeadline, setVerbose, log } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import { loadIdentity, registerAgent, resetAccount } from "./identity.js";
import { judgeChallenge } from "./judging.js";
import { answerQuery } from "./answering.js";

export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
  }
}

export interface BotArgs {
  identity?: string;
  register?: boolean;
  displayName?: string;
  once?: boolean;
  verbose?: boolean;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): BotArgs {
  const args: BotArgs = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--identity":
        args.identity = argv[++i];
        break;
      case "--register":
        args.register = true;
        break;
      case "--display-name":
        args.displayName = argv[++i];
        break;
      case "--once":
        args.once = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
    }
  }
  return args;
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
    return available;
  } catch (err) {
    log(`Failed to check balance: ${err}`);
    return 0;
  }
}

export async function processChallenges(client: FortyTwoClient, dualMode = false): Promise<number> {
  const pending = await client.getPendingChallenges(1, 50);
  const challenges = (pending.challenges ?? []) as Record<string, any>[];

  if (challenges.length === 0) {
    log("No pending challenges available");
    return 0;
  }

  const eligible = challenges.filter((ch) => {
    if (ch.has_voted) return false;
    const queryId = String(ch.query_id ?? "");
    if (dualMode && queryId && shouldAnswer(queryId, client.agentId)) return false;
    const effectiveDeadline = (ch.effective_voting_deadline ?? ch.judging_deadline_at ?? "") as string;
    const remaining = secondsUntilDeadline(effectiveDeadline);
    if (remaining > 0 && remaining < config.MIN_DEADLINE_SECONDS) {
      log(`[${String(ch.id).slice(0, 8)}] Skipping: only ${Math.round(remaining)}s until deadline`);
      return false;
    }
    return true;
  });

  log(`Found ${challenges.length} pending challenges (${eligible.length} eligible)`);

  const results = await Promise.allSettled(
    eligible.map(async (ch) => {
      const challengeId = String(ch.id);
      const effectiveDeadline = (ch.effective_voting_deadline ?? ch.judging_deadline_at ?? "") as string;
      const remaining = secondsUntilDeadline(effectiveDeadline);
      const answerCount = (ch.answer_count ?? 0) as number;
      await judgeChallenge(client, challengeId, remaining, answerCount);
    }),
  );

  let processed = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      processed++;
    } else {
      log(`[${String(eligible[i].id).slice(0, 8)}] Error judging: ${r.reason}`);
    }
  }

  return processed;
}

export async function processQueries(client: FortyTwoClient, dualMode = false): Promise<number> {
  const resp = await client.getActiveQueries(1, 50);
  const queries = (resp.queries ?? []) as Record<string, any>[];

  if (queries.length === 0) {
    log("No active queries available");
    return 0;
  }

  const eligible = queries.filter((q) => {
    const queryId = String(q.id);
    if (dualMode && !shouldAnswer(queryId, client.agentId)) return false;
    const createdAtStr = (q.created_at ?? "") as string;
    const decisionDeadlineStr = (q.decision_deadline_at ?? "") as string;
    const answerRemaining = answerRemainingSeconds(createdAtStr, decisionDeadlineStr);
    if (answerRemaining < -300) return false;
    return true;
  });

  log(`Found ${queries.length} active queries (${eligible.length} eligible)`);

  const results = await Promise.allSettled(
    eligible.map(async (q) => {
      await answerQuery(client, String(q.id));
    }),
  );

  let processed = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === "fulfilled") {
      processed++;
    } else {
      log(`[${String(eligible[i].id).slice(0, 8)}] Error answering: ${r.reason}`);
    }
  }

  return processed;
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

export async function main(args?: BotArgs): Promise<void> {
  const cfg = config.get();
  const opts = args ?? parseArgs();
  if (opts.verbose) setVerbose(true);
  const identityPath = opts.identity ?? cfg.identity_file;

  if (cfg.inference_type !== "local" && !cfg.openrouter_api_key) {
    log("OPENROUTER_API_KEY not set. Run onboarding first.");
    process.exit(1);
  }

  const role = cfg.bot_role;
  if (!["JUDGE", "ANSWERER", "ANSWERER_AND_JUDGE"].includes(role)) {
    log(`Invalid BOT_ROLE: ${role}`);
    process.exit(1);
  }

  log(`Bot role: ${role}`);

  const client = new FortyTwoClient();

  try {
    let identity = opts.register ? null : loadIdentity(identityPath);

    if (!identity) {
      log("No identity found, starting registration...");
      identity = await registerAgent(client, opts.displayName ?? "JudgeBot");
      log(`Registration complete! Agent ID: ${identity.agent_id}`);
    }

    await client.login(identity.agent_id, identity.secret);

    if (opts.once) {
      const available = await checkBalance(client);
      if (available < cfg.min_balance) {
        log(`Balance ${available.toFixed(2)} FOR is below minimum ${cfg.min_balance.toFixed(2)} FOR`);
        return;
      }
      const count = await runCycle(client);
      log(`Processed ${count} items. Exiting.`);
      return;
    }

    log(`Starting polling loop (interval: ${cfg.poll_interval}s)`);
    while (true) {
      const cycleStart = Date.now();
      try {
        const available = await checkBalance(client);
        if (available < cfg.min_balance) {
          throw new InsufficientFundsError(
            `Balance ${available.toFixed(2)} FOR is below minimum ${cfg.min_balance.toFixed(2)} FOR`,
          );
        }

        const count = await runCycle(client);
        if (count > 0) log(`Processed ${count} items this cycle`);
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          log(`${err.message} — resetting account...`);
          await resetAccount(client);
          log("Account reset complete!");
          continue;
        }
        log(`Error in polling cycle: ${err}`);
      }

      const elapsed = Date.now() - cycleStart;
      const delay = cfg.poll_interval * 1000 - elapsed;
      if (delay > 0) {
        await sleep(delay);
      } else {
        log(`Cycle took ${Math.round(elapsed / 1000)}s (> ${cfg.poll_interval}s), starting next immediately`);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      log(`Fatal error: ${err}`);
    }
  }
}
