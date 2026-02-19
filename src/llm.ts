import * as config from "./config.js";
import { sleep, parseLastLetter, verbose } from "./utils.js";

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
}

let semaphore: Semaphore | null = null;

function getSemaphore(): Semaphore {
  const cfg = config.get();
  if (!semaphore) semaphore = new Semaphore(cfg.llm_concurrency);
  return semaphore;
}

interface ChatMessage {
  role: string;
  content: string;
}

function getCompletionsUrl(): string {
  const cfg = config.get();
  if (cfg.inference_type === "local") {
    const base = cfg.llm_api_base.replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }
  return `${OPENROUTER_BASE}/chat/completions`;
}

async function callLlmApi(
  messages: ChatMessage[],
  retries = 2,
  temperature = 0.3,
): Promise<string> {
  const cfg = config.get();
  const isLocal = cfg.inference_type === "local";

  if (!isLocal && !cfg.openrouter_api_key) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const url = getCompletionsUrl();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (isLocal) {
    headers["Authorization"] = "Bearer EMPTY";
  } else {
    headers["Authorization"] = `Bearer ${cfg.openrouter_api_key}`;
    headers["X-Timeout"] = String(cfg.llm_timeout);
  }

  const payload = {
    model: cfg.llm_model,
    messages,
    temperature,
  };

  const sem = getSemaphore();

  for (let attempt = 0; attempt <= retries; attempt++) {
    await sem.acquire();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), cfg.llm_timeout * 1000);

      verbose(`→ POST ${url} model=${cfg.llm_model} msgs=${messages.length} temp=${temperature}`);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      verbose(`← ${resp.status} POST ${url}`);

      if (resp.status === 429) {
        verbose(`  rate-limited, backing off attempt ${attempt}`);
        const wait = Math.min(2 ** attempt * 2, 30) * 1000;
        await sleep(wait);
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text();
        verbose(`  error body: ${text.slice(0, 200)}`);
        throw new Error(`LLM API error ${resp.status}: ${text.slice(0, 300)}`);
      }

      const data = (await resp.json()) as any;
      const content = (data.choices[0].message.content as string).trim();
      verbose(`  response: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
      return content;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        if (attempt >= retries) {
          throw new Error(`LLM call timed out after ${retries + 1} attempts`);
        }
        continue;
      }
      if (attempt < retries) {
        const wait = 2 ** attempt * 1000;
        await sleep(wait);
        continue;
      }
      throw new Error(`LLM call failed after ${retries + 1} attempts: ${err}`);
    } finally {
      sem.release();
    }
  }

  throw new Error("LLM call exhausted retries");
}

export async function callLlm(prompt: string, retries = 2): Promise<string> {
  return callLlmApi([{ role: "user", content: prompt }], retries, 0.3);
}

export async function compareForRegistration(
  question: string,
  optionA: string,
  optionB: string,
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
      const response = await callLlm(prompt);
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
    const response = await callLlm(prompt, retries);
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
      const response = await callLlm(prompt, retries);
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
): Promise<string> {
  return callLlmApi(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: problem },
    ],
    retries,
    0.7,
  );
}
