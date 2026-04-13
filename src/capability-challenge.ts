import { FortyTwoClient, ApiError } from "./api-client.js";
import type { ChallengeRound } from "./api-types.js";
import * as llm from "./llm.js";
import { log, pinTask, unpinTask } from "./utils.js";
import { viewerBus } from "./event-bus.js";

const CHALLENGE_SYSTEM_PROMPT = [
  "You are solving a logic puzzle. Read the problem carefully and answer concisely.",
  "Many puzzles require Yes/No answers based on LTL operators.",
  "Respond in the format the puzzle expects (typically \"Yes\" or \"No\").",
].join(" ");

// Skip rounds whose deadline is closer than this — not enough time to generate + submit.
const MIN_TIME_LEFT_MS = 30_000;

export interface ChallengeContext {
  client: FortyTwoClient;
  inFlight: Set<string>;
}

export function createChallengeContext(client: FortyTwoClient): ChallengeContext {
  return { client, inFlight: new Set() };
}

/**
 * Poll active Foundation Pool rounds and submit answers for any that the
 * authenticated agent has not answered yet.
 *
 * Returns the number of rounds we attempted to answer this cycle.
 */
export async function processChallengeRounds(ctx: ChallengeContext): Promise<number> {
  viewerBus.setState("SCANNING");

  let page;
  try {
    page = await ctx.client.listActiveChallengeRounds(1, 50);
  } catch (err) {
    // Backwards compat: old server doesn't have Foundation Pool yet.
    if (err instanceof ApiError && err.status === 404) {
      viewerBus.setChallengeRoundsAvailable(0);
      return 0;
    }
    throw err;
  }

  const rounds = (page.items ?? []).filter((r) => !r.has_answered && r.status === "active");
  viewerBus.setChallengeRoundsAvailable(rounds.length);

  if (rounds.length === 0) {
    log("No active capability challenge rounds available");
    return 0;
  }

  let attempted = 0;
  // Process sequentially so that SUBMITTING/THINKING state transitions do not
  // fight the polling loop's COOLDOWN state. `inFlight` still protects against
  // a later cycle picking up a round that is still being processed.
  for (const round of rounds) {
    if (ctx.inFlight.has(round.id)) continue;
    ctx.inFlight.add(round.id);
    attempted++;
    try {
      await answerChallengeRound(ctx, round);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      log(`[challenge ${round.id.slice(0, 8)}] failed: ${msg}`);
      // Node just crossed into Capable mid-cycle — remaining rounds in this
      // batch will all fail with the same tier check. Stop the loop so the
      // next cycle can dispatch to queries/judgments.
      if (isTierMismatchError(msg)) {
        log("Reached Capability 42 — leaving the Capability Challenge loop.");
        break;
      }
    } finally {
      ctx.inFlight.delete(round.id);
    }
  }
  return attempted;
}

function isTierMismatchError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("capable nodes cannot") || m.includes("capability challenge");
}

async function answerChallengeRound(ctx: ChallengeContext, round: ChallengeRound): Promise<void> {
  const tag = round.id.slice(0, 8);

  const endsAt = new Date(round.ends_at).getTime();
  if (!Number.isFinite(endsAt) || endsAt - Date.now() < MIN_TIME_LEFT_MS) {
    log(`[challenge ${tag}] skipping — not enough time left`);
    return;
  }

  pinTask(round.id, `Challenge ${tag}`);
  try {
    viewerBus.setState("THINKING");
    log(`[challenge ${tag}] answering puzzle...`);
    const answer = await llm.generateAnswer(CHALLENGE_SYSTEM_PROMPT, round.content);

    viewerBus.setState("SUBMITTING");
    const response = await ctx.client.submitChallengeAnswer(round.id, answer);
    log(`[challenge ${tag}] ✓ submitted (staked ${response.staked_amount} FOR)`);
  } finally {
    unpinTask(round.id);
  }
}
