import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import * as config from "./config.js";
import { parseLastLetter, verbose } from "./utils.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Simple semaphore for concurrency control
class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  activeCount(): number {
    return this.current;
  }

  queuedCount(): number {
    return this.queue.length;
  }
}

let semaphore: Semaphore | null = null;

function getSemaphore(): Semaphore {
  const cfg = config.get();
  if (!semaphore) semaphore = new Semaphore(cfg.llm_concurrency);
  return semaphore;
}

export function isLlmBusy(): boolean {
  return (semaphore?.queuedCount() ?? 0) > 0;
}

export function resetLlmClient(): void {
  openaiClient = null;
  semaphore = new Semaphore(config.get().llm_concurrency);
}

type LlmPurpose = "ranking" | "generation" | "registration" | "other";

const stats = {
  calls: 0,
  errors: 0,
  ranking: { count: 0, totalMs: 0, errors: 0 },
  generation: { count: 0, totalMs: 0, errors: 0 },
};

function recordSuccess(purpose: LlmPurpose, ms: number) {
  stats.calls++;
  if (purpose === "ranking") {
    stats.ranking.count++;
    stats.ranking.totalMs += ms;
  } else if (purpose === "generation") {
    stats.generation.count++;
    stats.generation.totalMs += ms;
  }
}

function recordError(purpose: LlmPurpose) {
  stats.calls++;
  stats.errors++;
  if (purpose === "ranking") stats.ranking.errors++;
  if (purpose === "generation") stats.generation.errors++;
}

export function getLlmStats() {
  const active = semaphore?.activeCount() ?? 0;
  const queued = semaphore?.queuedCount() ?? 0;
  const rankingAvg = stats.ranking.count > 0
    ? Math.round(stats.ranking.totalMs / stats.ranking.count)
    : null;
  const generationAvg = stats.generation.count > 0
    ? Math.round(stats.generation.totalMs / stats.generation.count)
    : null;
  return {
    active,
    queued,
    calls: stats.calls,
    errors: stats.errors,
    rankingAvgMs: rankingAvg,
    generationAvgMs: generationAvg,
  };
}

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const cfg = config.get();
  const isLocal = cfg.inference_type === "local";
  openaiClient = new OpenAI({
    baseURL: isLocal ? cfg.llm_api_base.replace(/\/+$/, "") : OPENROUTER_BASE,
    apiKey: isLocal ? "EMPTY" : cfg.openrouter_api_key,
    timeout: cfg.llm_timeout * 1000,
    maxRetries: 2,
    defaultHeaders: isLocal ? undefined : {
      "HTTP-Referer": "https://app.fortytwo.network",
      "X-Title": "Fortytwo",
      "X-Timeout": String(cfg.llm_timeout),
    },
  });
  return openaiClient;
}

async function callLlmApi(
  messages: ChatCompletionMessageParam[],
  retries = 2,
  temperature = 0.3,
  signal?: AbortSignal,
  purpose: LlmPurpose = "other",
): Promise<string> {
  const cfg = config.get();
  const isLocal = cfg.inference_type === "local";

  if (!isLocal && !cfg.openrouter_api_key) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const client = getClient();
  const sem = getSemaphore();

  await sem.acquire();
  const start = Date.now();
  try {
    if (signal?.aborted) throw new Error("LLM call aborted");

    verbose(`→ model=${cfg.llm_model} msgs=${messages.length} temp=${temperature}`);

    const resp = await client.chat.completions.create(
      {
        model: cfg.llm_model,
        messages,
        temperature,
      },
      {
        signal: signal ?? undefined,
        maxRetries: retries,
      },
    );

    const content = (resp.choices[0].message.content ?? "").trim();
    verbose(`← ${cfg.llm_model} (${Date.now() - start}ms) ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
    recordSuccess(purpose, Date.now() - start);
    return content;
  } catch (err) {
    verbose(`✗ failed after ${Date.now() - start}ms: ${err}`);
    recordError(purpose);
    if (signal?.aborted) throw new Error("LLM call aborted");
    throw err;
  } finally {
    sem.release();
  }
}

export async function callLlm(
  prompt: string,
  retries = 2,
  signal?: AbortSignal,
  purpose: LlmPurpose = "other",
): Promise<string> {
  return callLlmApi([{ role: "user", content: prompt }], retries, 0.3, signal, purpose);
}

export async function compareForRegistration(
  question: string,
  optionA: string,
  optionB: string,
  signal?: AbortSignal,
): Promise<number> {
  const prompt =
    `######Problem######: \n${question}\n` +
    `######Solution A######. \n${optionA}\n` +
    `######Solution B######. \n${optionB}\n` +
    `######Instruction######:\n` +
    `Select the best one of the two proposed solutions to the problem. ` +
    `THEN end output with best solution overall index (A or B) on the new line ` +
    `(Only letter, nothing else).\n` +
    `Don't try to re-solve/re-compute/re-think the problem. ` +
    `Only find flows/mistakes in a proposed solutions and pick the best one (and that not validated/certified by you to be ideal/fully correct).\n` +
    `If both solutions are equal or you cannot determine which is better, output U.\n` +
    `######Decision######:`;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await callLlm(prompt, 2, signal, "registration");
      const letter = parseLastLetter(response, new Set(["A", "B", "U"]));
      if (letter !== null) {
        if (letter === "A") return 1;
        if (letter === "B") return -1;
        return 0;
      }
    }
  } catch {
    return 0;
  }

  return 0;
}

export async function evaluateGoodEnough(
  problem: string,
  solution: string,
  retries = 2,
  signal?: AbortSignal,
): Promise<boolean> {
  const prompt =
    `######Problem######:\n${problem}\n` +
    `######Solution######:\n${solution}\n` +
    `######Instruction######:\n` +
    `Evaluate whether this solution is a genuine, complete attempt to solve the problem.\n` +
    `A "good enough" solution must:\n` +
    `1. Actually address the problem (not off-topic, spam, or placeholder)\n` +
    `2. Provide a substantive response (not just "I don't know" or trivially short)\n` +
    `3. Demonstrate effort and reasoning (even if imperfect or wrong)\n\n` +
    `Answer GOOD if this is a genuine attempt, or BAD if it is not.\n` +
    `End your output with exactly one word on the last line: GOOD or BAD\n` +
    `######Evaluation######:`;

  try {
    const response = await callLlm(prompt, retries, signal, "ranking");
    const letter = parseLastLetter(response, new Set(["GOOD", "BAD"]));
    if (letter === "BAD") return false;
    return true;
  } catch {
    return false;
  }
}

export async function comparePairwise(
  problem: string,
  solutionA: string,
  solutionB: string,
  retries = 2,
  signal?: AbortSignal,
): Promise<string | null> {
  const prompt =
    `######Problem######: \n${problem}\n` +
    `######Solution A######. \n${solutionA}\n` +
    `######Solution B######. \n${solutionB}\n` +
    `######Instruction######:\n` +
    `Select the best one of the two proposed solutions to the problem. ` +
    `THEN end output with best solution overall index (A or B) on the new line ` +
    `(Only letter, nothing else).\n` +
    `Don't try to re-solve/re-compute/re-think the problem. ` +
    `Only find flows/mistakes in a proposed solutions and pick better one (and that not validated/certified by you to be ideal/fully correct).\n` +
    `If both solutions are equal or you cannot determine which is better, output U.\n` +
    `######Decision######:`;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await callLlm(prompt, retries, signal, "ranking");
      const letter = parseLastLetter(response, new Set(["A", "B", "U"]));
      if (letter !== null) return letter;
    }
  } catch {
    return null;
  }

  return "U";
}

export async function generateAnswer(
  systemPrompt: string,
  problem: string,
  retries = 2,
  signal?: AbortSignal,
): Promise<string> {
  return callLlmApi(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: problem },
    ],
    retries,
    0.7,
    signal,
    "generation",
  );
}
