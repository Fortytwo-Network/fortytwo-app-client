import * as config from "./config.js";
import { log, pinTask, unpinTask } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import * as llm from "./llm.js";

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
  const apiTimeoutMs = Math.max(30_000, cfg.llm_timeout * 1000);

  async function withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out`)), apiTimeoutMs),
        ),
      ]);
      return result;
    } catch (err) {
      let detail = "";
      if (err instanceof Error) {
        const msg = err.message;
        const jsonStart = msg.indexOf("{");
        if (jsonStart !== -1) {
          try {
            const parsed = JSON.parse(msg.slice(jsonStart));
            if (parsed?.detail) detail = String(parsed.detail);
          } catch {
            // ignore parse errors
          }
        }
      }
      if (detail) {
        log(`[${tag}] ${detail}`);
      } else {
        log(`[${tag}] ${label} failed after ${Date.now() - start}ms: ${err}`);
      }
      throw err;
    }
  }

  log(`[${tag}] Answering started`);

  // Step 0: Fetch query detail to check state and precise deadline
  let query = await withTimeout("Fetch query", () => client.getQuery(queryId));

  // Already answered
  if (query.has_answered) {
    log(`[${queryId.slice(0, 8)}] Already answered, skipping`);
    return;
  }

  const remaining = computeEffectiveAnswerDeadline(query);
  const minAnswerTime = cfg.llm_timeout + 30;

  if (remaining <= 0) {
    log(`[${queryId.slice(0, 8)}] Skipping: deadline passed or unavailable`);
    return;
  }

  if (remaining > 0 && remaining < minAnswerTime) {
    log(`[${queryId.slice(0, 8)}] Skipping: only ${Math.round(remaining)}s until deadline (need ${minAnswerTime}s)`);
    return;
  }

  const status = (query.status ?? "") as string;
  if (status !== "active" && status !== "answering_grace") {
    log(`[${queryId.slice(0, 8)}] Query status is '${status}', not answerable — skipping`);
    return;
  }

  // Step 1: Join the query
  if (query.has_joined) {
    log(`[${queryId.slice(0, 8)}] Already joined, proceeding to answer`);
  } else {
    try {
      const joinResult = await withTimeout("Join query", () => client.joinQuery(queryId));
      log(`[${tag}] Joined, stake: ${joinResult.stake_amount ?? "?"} FOR`);
    } catch (err) {
      const msg = String(err).toLowerCase();
      if (msg.includes("maximum") || msg.includes("full") || msg.includes("participants")) {
        log(`[${tag}] Query full, skipping`);
        return;
      }
      if (msg.includes("already")) {
        log(`[${tag}] Already joined, proceeding`);
      } else {
        throw err;
      }
    }
    // Re-fetch to get decrypted content
    query = await withTimeout("Refetch query", () => client.getQuery(queryId));
  }

  // Step 2: Extract decrypted content
  const problem = query.decrypted_content as string | undefined;
  if (!problem) throw new Error(`No decrypted content for query ${queryId}`);

  // Step 3: Generate answer via LLM
  pinTask(queryId, `Answering ${tag}`);
  try {
    const tGen = Date.now();
    const answerText = await llm.generateAnswer(
      cfg.answerer_system_prompt,
      problem,
      ANSWERER_LLM_RETRIES,
    );
    log(`[${tag}] Generated answer in ${Date.now() - tGen}ms`);

    // Step 4: Base64-encode the answer
    const encryptedContent = Buffer.from(answerText, "utf-8").toString("base64");

    // Step 5: Submit answer
    log(`[${tag}] Submitting answer...`);
    const result = await withTimeout("Submit answer", () => client.submitAnswer(queryId, encryptedContent));
    log(`[${tag}] Answer submitted! answer_id=${result.id ?? "?"}`);
  } finally {
    unpinTask(queryId);
    log(`[${tag}] Answering finished`);
  }
}
