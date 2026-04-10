import * as config from "./config.js";
import { log, pinTask, unpinTask } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import * as llm from "./llm.js";
import { viewerBus } from "./event-bus.js";

const ANSWERER_LLM_RETRIES = 1;

function secondsUntil(dtStr: string): number {
  try {
    const normalized = dtStr.replace("Z", "+00:00");
    const dt = new Date(normalized);
    if (isNaN(dt.getTime())) return 0;
    return (dt.getTime() - Date.now()) / 1000;
  } catch {
    return 0;
  }
}

export function computeEffectiveAnswerDeadline(query: Record<string, any>): number {
  // If already in grace period and we have the exact end time, use it
  const graceEnds = query.answering_grace_ends_at as string | undefined;
  if (graceEnds) return secondsUntil(graceEnds);

  // Otherwise: answer_deadline + grace duration = latest possible submission time
  const answerDeadlineStr = (query.answer_deadline_at ?? "") as string;
  const graceSeconds = (query.extra_completion_duration_answers_seconds ?? 300) as number;

  try {
    const normalized = answerDeadlineStr.replace("Z", "+00:00");
    const answerDeadline = new Date(normalized);
    if (isNaN(answerDeadline.getTime())) return 0;
    const effectiveDeadline = new Date(answerDeadline.getTime() + graceSeconds * 1000);
    return (effectiveDeadline.getTime() - Date.now()) / 1000;
  } catch {
    return 0;
  }
}

export async function answerQuery(client: FortyTwoClient, queryId: string): Promise<void> {
  const tag = queryId.slice(0, 8);
  const cfg = config.get();
  const timeoutMs = cfg.llm_timeout * 1000;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    log(`[${tag}] ↳ Answering started`);
    viewerBus.setState("JOINING");

    // Step 0: Fetch query detail to check state and precise deadline
    let query = await client.getQuery(queryId);

    if (query.has_answered) {
      log(`[${tag}] ↳ Already answered, skipping`);
      return;
    }

    const remaining = computeEffectiveAnswerDeadline(query);
    const minAnswerTime = cfg.llm_timeout + 30;

    if (remaining <= 0) {
      log(`[${tag}] ↳ Skipping: deadline passed`);
      return;
    }

    if (remaining > 0 && remaining < minAnswerTime) {
      log(`[${tag}] ↳ Skipping: only ${Math.round(remaining)}s left (need ${minAnswerTime}s)`);
      return;
    }

    const status = (query.status ?? "") as string;
    if (status !== "active" && status !== "answering_grace") {
      log(`[${tag}] ↳ Query status '${status}', not answerable — skipping`);
      return;
    }

    // Step 1: Join the query
    if (query.has_joined) {
      log(`[${tag}] ↳ Already joined, proceeding`);
    } else {
      try {
        const joinResult = await client.joinQuery(queryId);
        log(`[${tag}] ✓ Joined, stake: ${joinResult.stake_amount ?? "?"} FOR`);
      } catch (err) {
        const msg = String(err).toLowerCase();
        if (msg.includes("maximum") || msg.includes("full") || msg.includes("participants")) {
          log(`[${tag}] ↳ Query full, skipping`);
          return;
        }
        if (msg.includes("already")) {
          log(`[${tag}] ↳ Already joined, proceeding`);
        } else {
          throw err;
        }
      }
      query = await client.getQuery(queryId);
    }

    // Step 2: Extract decrypted content
    const problem = query.decrypted_content as string | undefined;
    if (!problem) throw new Error(`No decrypted content for query ${queryId}`);

    // Step 3: Generate answer via LLM
    viewerBus.setState("THINKING");
    viewerBus.updateStats({
      activeQueryId: queryId,
      activeQuestionText: problem,
      activeQuestionCat: String(query.specialization ?? "general"),
    });
    pinTask(queryId, `Answering ${tag}`);
    try {
      const tGen = Date.now();
      const answerText = await llm.generateAnswer(
        cfg.answerer_system_prompt,
        problem,
        ANSWERER_LLM_RETRIES,
        ac.signal,
      );
      log(`[${tag}] ✓ Generated answer in ${Date.now() - tGen}ms`);

      viewerBus.setState("SUBMITTING");
      const encryptedContent = Buffer.from(answerText, "utf-8").toString("base64");

      log(`[${tag}] ↳ Submitting answer...`);
      const result = await client.submitAnswer(queryId, encryptedContent);
      log(`[${tag}] ✓ Answer submitted! answer_id=${result.id ?? "?"}`);
      viewerBus.updateStats({ answers: (viewerBus.stats.answers || 0) + 1 });
    } finally {
      unpinTask(queryId);
      viewerBus.updateStats({
        activeQueryId: null,
        activeQuestionText: null,
        activeQuestionCat: null,
      });
    }
  } catch (err) {
    if (ac.signal.aborted) {
      log(`[${tag}] ✕ Answering timed out after ${cfg.llm_timeout}s`);
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
