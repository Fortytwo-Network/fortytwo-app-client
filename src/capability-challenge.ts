import { FortyTwoClient } from "./api-client.js";
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

/**
 * Raised when `llm.generateAnswer` fails after a successful join. Signals that
 * inference is unavailable, so the processing loop must stop — otherwise we
 * keep staking FOR on rounds we can't answer until `challenge_locked` is
 * drained into dead-lock. Rethrown from `processChallengeRounds` so the main
 * polling loop can gate subsequent cycles on a `pingLlm()` health check.
 */
export class LlmFailureError extends Error {
  constructor(cause: Error) {
    super(`LLM generation failed: ${cause.message}`);
    this.name = "LlmFailureError";
  }
}

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

  const page = await ctx.client.listActiveChallengeRounds(1, 50);

  const rounds = (page.items ?? []).filter(
    (r) => !r.has_answered && r.status === "active" && r.slots_remaining > 0,
  );
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

      // Reasons to abort the whole batch — continuing would waste FOR or spam
      // the server with doomed requests.
      const exitReason = classifyFatalError(err, msg);
      if (exitReason) {
        log(`${exitReason} — leaving the Capability Challenge loop.`);
        ctx.inFlight.delete(round.id);
        // LLM failures bubble up so the polling loop can ping before resuming.
        if (err instanceof LlmFailureError) throw err;
        break;
      }
    } finally {
      ctx.inFlight.delete(round.id);
    }
  }
  return attempted;
}

/**
 * Decide whether an error from `answerChallengeRound` should abort the whole
 * batch. Returns a human-readable reason, or null to keep going.
 */
function classifyFatalError(err: unknown, msg: string): string | null {
  if (err instanceof LlmFailureError) {
    return "Inference unavailable (joins would burn FOR without answers)";
  }
  const lower = msg.toLowerCase();
  if (lower.includes("capable nodes cannot") || lower.includes("reach capability")) {
    return "Reached Capability 42";
  }
  if (lower.includes("insufficient for balance") || lower.includes("insufficient balance")) {
    return "challenge_locked FOR exhausted";
  }
  return null;
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
    // Step 1: Obtain puzzle content. Listing doesn't carry `content`; detail
    // does (for users who have already joined) and `joinChallengeRound`
    // returns it directly for fresh joins.
    const content = await obtainContent(ctx, round, tag);

    // Step 2: Generate answer via LLM. Wrap in a dedicated error type so the
    // batch loop can detect and abort — we must not keep joining rounds when
    // inference is dead.
    viewerBus.setState("THINKING");
    log(`[challenge ${tag}] answering puzzle...`);
    let answer: string;
    try {
      answer = await llm.generateAnswer(CHALLENGE_SYSTEM_PROMPT, content);
    } catch (err) {
      throw new LlmFailureError(err as Error);
    }

    // Step 3: Submit.
    viewerBus.setState("SUBMITTING");
    await ctx.client.submitChallengeAnswer(round.id, answer);
    log(`[challenge ${tag}] ✓ submitted`);
  } finally {
    unpinTask(round.id);
  }
}

async function obtainContent(
  ctx: ChallengeContext,
  round: ChallengeRound,
  tag: string,
): Promise<string> {
  // Already joined in a previous cycle — no need to stake again, just fetch
  // the round detail (server returns `content` for participants).
  if (round.has_joined) {
    log(`[challenge ${tag}] already joined — fetching content...`);
    const detail = await ctx.client.getChallengeRound(round.id);
    if (!detail.content) {
      throw new Error(`Round detail is missing content despite has_joined=true`);
    }
    return detail.content;
  }

  viewerBus.setState("JOINING");
  log(`[challenge ${tag}] joining round...`);
  try {
    const joined = await ctx.client.joinChallengeRound(round.id);
    log(`[challenge ${tag}] ✓ joined (staked ${joined.stake_amount} FOR)`);
    return joined.content;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Race: listing said has_joined=false, server says we already joined.
    // Fetch detail instead of double-staking.
    if (/already joined/i.test(msg)) {
      log(`[challenge ${tag}] join race — fetching content from detail...`);
      const detail = await ctx.client.getChallengeRound(round.id);
      if (!detail.content) {
        throw new Error(`Round detail is missing content after already-joined fallback`);
      }
      return detail.content;
    }
    throw err;
  }
}
