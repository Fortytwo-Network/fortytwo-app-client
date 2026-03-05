import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as config from "./config.js";
import { sleep, mapWithConcurrency } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import * as llm from "./llm.js";

const MAX_TIEBREAK_ATTEMPTS = 5;

export type LogFn = (msg: string) => void;

export interface Identity {
  agent_id: string;
  secret: string;
  public_key_pem?: string;
  private_key_pem?: string;
}

export function generateRsaKeypair(): { privatePem: string; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privatePem: privateKey as string, publicPem: publicKey as string };
}

export function saveIdentity(path: string, identity: Identity): void {
  writeFileSync(path, JSON.stringify(identity, null, 2));
}

export function loadIdentity(path: string): Identity | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data.agent_id && data.secret) return data as Identity;
    return null;
  } catch {
    return null;
  }
}

interface Challenge {
  id: string | number;
  question: string;
  option_a: string;
  option_b: string;
}

interface ChallengeResponse {
  challenge_id: string;
  choice: number;
}

async function solveChallenges(challenges: Challenge[], log: LogFn): Promise<ChallengeResponse[]> {
  const total = challenges.length;
  let compared = 0;
  let solved = 0;
  const concurrency = config.get().llm_concurrency;

  // Phase 1: Run forward (a,b) + inverse (b,a) concurrently for all challenges
  const CHALLENGE_TIMEOUT = 120_000; // 2 min per challenge

  const pairResults = await mapWithConcurrency(
    challenges,
    concurrency,
    async (ch, idx): Promise<[number, Challenge, number]> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CHALLENGE_TIMEOUT);
      try {
        const [forward, inverse] = await Promise.all([
          llm.compareForRegistration(ch.question, ch.option_a, ch.option_b, controller.signal),
          llm.compareForRegistration(ch.question, ch.option_b, ch.option_a, controller.signal),
        ]);
        const result = forward + -inverse;
        compared++;
        if (result !== 0) solved++;
        const { active, max } = llm.getLlmConcurrency();
        log(`~Comparing: ${compared}/${total} (${solved} settled) [LLM ${active}/${max}]`);
        return [idx, ch, result];
      } catch {
        compared++;
        const { active, max } = llm.getLlmConcurrency();
        log(`~Comparing: ${compared}/${total} (${solved} settled) [LLM ${active}/${max}]`);
        return [idx, ch, 0];
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  // Collect resolved and unresolved
  const responses = new Map<number, ChallengeResponse>();
  const unresolved: [number, Challenge, number][] = [];

  for (const [idx, ch, net] of pairResults) {
    if (net > 0) {
      responses.set(idx, { challenge_id: String(ch.id), choice: 0 });
    } else if (net < 0) {
      responses.set(idx, { challenge_id: String(ch.id), choice: 1 });
    } else {
      unresolved.push([idx, ch, net]);
    }
  }

  // Phase 2: Sequential tiebreak for unresolved challenges
  for (let [idx, ch, net] of unresolved) {
    for (let tb = 1; tb <= MAX_TIEBREAK_ATTEMPTS; tb++) {
      let score: number;
      if (Math.random() < 0.5) {
        score = await llm.compareForRegistration(ch.question, ch.option_a, ch.option_b);
      } else {
        score = -(await llm.compareForRegistration(ch.question, ch.option_b, ch.option_a));
      }
      net += score;
      if (net !== 0) break;
    }

    let choice: number;
    if (net > 0) choice = 0;
    else if (net < 0) choice = 1;
    else choice = Math.random() < 0.5 ? 0 : 1;

    responses.set(idx, { challenge_id: String(ch.id), choice });
    solved++;
    const { active, max } = llm.getLlmConcurrency();
    log(`~Solving: ${solved}/${total} [LLM ${active}/${max}]`);
  }

  // Return in original order
  return Array.from({ length: total }, (_, i) => responses.get(i)!);
}

export async function registerAgent(
  client: FortyTwoClient,
  displayName = "JudgeBot",
  log: LogFn = console.log,
): Promise<Identity> {
  let attempt = 0;

  while (true) {
    attempt++;
    log(`Attempt ${attempt} — registering "${displayName}"...`);

    const { privatePem, publicPem } = generateRsaKeypair();

    try {
      const challengeData = await client.register(publicPem, displayName);
      const sessionId = challengeData.challenge_session_id as string;
      const challenges = challengeData.challenges as Challenge[];
      const requiredCorrect = (challengeData.required_correct as number) ?? 17;

      log(`~Solving: 0/${challenges.length}`);

      const responses = await solveChallenges(challenges, log);
      log(`Submitting answers (need ${requiredCorrect} correct)...`);
      const result = await client.completeRegistration(sessionId, responses);

      if (!result.passed) {
        const correct = result.correct_count ?? 0;
        log(`Failed: ${correct}/${challenges.length} correct (need ${requiredCorrect}). Retrying...`);
        await sleep(2000);
        continue;
      }

      const agentId = String(result.agent_id);
      const correct = result.correct_count ?? challenges.length;
      const secret = result.secret as string;

      const identity: Identity = {
        agent_id: agentId,
        secret,
        public_key_pem: publicPem,
        private_key_pem: privatePem,
      };
      saveIdentity(config.get().identity_file, identity);
      log(`Passed! ${correct}/${challenges.length} correct — Agent ID: ${agentId}`);

      return identity;
    } catch (err) {
      log(`Attempt ${attempt} error: ${err}. Retrying in 5s...`);
      await sleep(5000);
    }
  }
}

export async function reactivateAccount(
  client: FortyTwoClient,
  agentId: string,
  secret: string,
  log: LogFn = console.log,
): Promise<void> {
  let attempt = 0;

  while (true) {
    attempt++;
    log(`Reactivation attempt ${attempt}...`);

    try {
      const challengeData = await client.startReactivation(agentId, secret);
      const sessionId = challengeData.challenge_session_id as string;
      const challenges = challengeData.challenges as Challenge[];
      const requiredCorrect = (challengeData.required_correct as number) ?? 17;

      log(`~Solving: 0/${challenges.length}`);

      const responses = await solveChallenges(challenges, log);
      log(`Submitting answers (need ${requiredCorrect} correct)...`);
      const result = await client.completeReactivation(sessionId, responses);

      if (!result.passed) {
        const correct = result.correct_count ?? 0;
        log(`Failed: ${correct}/${challenges.length} correct. Retrying...`);
        await sleep(5000);
        continue;
      }

      log(`Reactivation successful! (attempt ${attempt})`);
      return;
    } catch (err) {
      log(`Reactivation attempt ${attempt} error: ${err}. Retrying in 10s...`);
      await sleep(10_000);
    }
  }
}

export async function resetAccount(
  client: FortyTwoClient,
  log: LogFn = console.log,
): Promise<void> {
  let attempt = 0;

  while (true) {
    attempt++;
    log(`Reset attempt ${attempt}...`);

    try {
      const challengeData = await client.startAccountReset();
      const sessionId = challengeData.challenge_session_id as string;
      const challenges = challengeData.challenges as Challenge[];
      const requiredCorrect = (challengeData.required_correct as number) ?? 17;
      const cooldownMinutes = (challengeData.cooldown_minutes as number) ?? 10;

      log(`~Solving: 0/${challenges.length}`);

      const responses = await solveChallenges(challenges, log);
      log(`Submitting answers (need ${requiredCorrect} correct)...`);
      const result = await client.completeAccountReset(sessionId, responses);

      if (!result.passed) {
        const correct = result.correct_count ?? 0;
        const waitTime = Math.max(cooldownMinutes * 60 * 1000, 5000);
        log(`Failed: ${correct}/${challenges.length} correct. Waiting...`);
        await sleep(waitTime);
        continue;
      }

      log(`Reset successful! (attempt ${attempt})`);
      return;
    } catch (err) {
      const msg = String(err).toLowerCase();
      if (msg.includes("cooldown") || msg.includes("limited")) {
        log(`Reset attempt ${attempt} hit cooldown. Waiting 10 min...`);
        await sleep(600_000);
      } else {
        log(`Reset attempt ${attempt} error: ${err}. Retrying in 10s...`);
        await sleep(10_000);
      }
    }
  }
}
