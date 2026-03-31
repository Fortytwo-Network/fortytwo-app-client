import * as config from "./config.js";
import { log, mapWithConcurrency, pinTask, unpinTask } from "./utils.js";
import { FortyTwoClient } from "./api-client.js";
import * as llm from "./llm.js";
import { viewerBus, type JudgeDetail } from "./event-bus.js";

const RANKING_LLM_RETRIES = 0;

export function buildPairwisePairs(n: number): [number, number][] {
  if (n < 2) return [];

  const pairs: [number, number][] = [];

  // Chain 1: adjacent pairs with direct + inverse
  for (let i = 0; i < n - 1; i++) {
    pairs.push([i, i + 1]);
    pairs.push([i + 1, i]);
  }

  // Chain 2: cross pairs linking distant elements
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i++) {
    const j = i + half;
    pairs.push([i, j]);
    pairs.push([j, i]);
  }

  return pairs;
}

export function estimateLlmTime(answerCount: number): number {
  const cfg = config.get();
  const timeout = cfg.llm_timeout;
  const concurrency = cfg.llm_concurrency;

  // Phase 1: good-enough evals
  const goodEnoughBatches = Math.ceil(answerCount / concurrency);
  const goodEnoughTime = goodEnoughBatches * timeout;

  // Phase 2: pairwise (worst case: all answers good)
  const pairCount = buildPairwisePairs(answerCount).length;
  const pairwiseBatches = pairCount > 0 ? Math.ceil(pairCount / concurrency) : 0;
  const pairwiseTime = pairwiseBatches * timeout;

  return goodEnoughTime + pairwiseTime;
}

export function computeBradleyTerry(wins: number[][]): number[] {
  const n = wins.length;
  if (n === 0) return [];
  if (n === 1) return [1.0];

  let strengths = new Array(n).fill(1.0);

  for (let iter = 0; iter < config.BT_MAX_ITERATIONS; iter++) {
    const oldStrengths = [...strengths];

    for (let i = 0; i < n; i++) {
      let numerator = 0;
      let denominator = 0;

      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const total = wins[i][j] + wins[j][i];
        if (total > 0) {
          numerator += wins[i][j];
          denominator += total / (strengths[i] + strengths[j]);
        }
      }

      strengths[i] = denominator > 0 ? numerator / denominator : 1.0;
    }

    // Normalize
    const s = strengths.reduce((a, b) => a + b, 0);
    if (s > 0) strengths = strengths.map((x) => (x / s) * n);

    // Check convergence
    const maxChange = Math.max(...strengths.map((v, i) => Math.abs(v - oldStrengths[i])));
    if (maxChange < config.BT_CONVERGENCE_THRESHOLD) break;
  }

  return strengths;
}

interface Answer {
  id: string;
  decrypted_content?: string;
  [key: string]: any;
}

export async function judgeChallenge(
  client: FortyTwoClient,
  challengeId: string,
  remainingSeconds: number,
  answerCountHint = 0,
): Promise<void> {
  const tag = challengeId.slice(0, 8);
  const concurrency = config.get().llm_concurrency;

  // Step 0: Pre-join time budget check
  if (answerCountHint > 0) {
    const estimatedTime = estimateLlmTime(answerCountHint);
    const estimatedTotal = estimatedTime + 30;
    if (estimatedTotal > remainingSeconds) {
      log(`[${tag}] ↳ Time budget exceeded: need ~${Math.round(estimatedTotal)}s but only ${Math.round(remainingSeconds)}s left`);
      return;
    }
  }

  // Step 1: Join the challenge
  try {
    const joinResult = await client.joinChallenge(challengeId);
    log(`[${tag}] ✓ Joined, stake: ${joinResult.stake_amount ?? "?"} FOR`);
  } catch (err) {
    const msg = String(err).toLowerCase();
    if (msg.includes("maximum") || msg.includes("full") || msg.includes("participants")) {
      log(`[${tag}] ↳ Challenge full, skipping`);
      return;
    }
    if (msg.includes("already")) {
      log(`[${tag}] ↳ Already joined, proceeding`);
    } else {
      throw err;
    }
  }

  // Step 2: Get challenge details
  const challenge = await client.getChallenge(challengeId);
  const problem = challenge.decrypted_query_content as string | undefined;
  if (!problem) throw new Error(`No decrypted query content for challenge ${challengeId}`);

  // Step 3: Get answers
  const answersResp = await client.getChallengeAnswers(challengeId);
  const answers = (answersResp.answers ?? []) as Answer[];
  if (answers.length === 0) throw new Error(`No answers for challenge ${challengeId}`);

  const judgeDetail: JudgeDetail = {
    challengeId,
    questionText: problem,
    answers: answers.map((a) => ({
      id: a.id,
      content: a.decrypted_content ?? "",
      nodeId: a.agent_id as string | undefined,
    })),
    comparisons: [],
    finalRankings: [],
    goodAnswers: [],
    phase: "reading_answers",
    currentPairA: null,
    currentPairB: null,
    comparisonIndex: 0,
    totalComparisons: 0,
    scores: {},
  };
  viewerBus.setJudgeDetail(judgeDetail);

  log(`[${tag}] ↳ Got ${answers.length} answers, evaluating quality...`);
  pinTask(challengeId, `Judging ${tag}`);

  try {
    // Step 4: Evaluate all answers for "good enough" concurrently
    let evalDone = 0;
    const evalTotal = answers.length;
    const goodAnswers: Answer[] = [];
    const badAnswers: Answer[] = [];

    const evalResults = await mapWithConcurrency(
      answers,
      concurrency,
      async (answer, i): Promise<[Answer, boolean]> => {
        const content = answer.decrypted_content ?? "";
        if (!content) return [answer, false];
        const isGood = await llm.evaluateGoodEnough(problem, content, RANKING_LLM_RETRIES, AbortSignal.timeout(60_000));
        evalDone++;
        const verdict = isGood ? "good" : "bad";
        log(`[${tag}] ↳ Eval ${evalDone}/${evalTotal} → ${verdict}`);
        return [answer, isGood];
      },
    );

    for (const [answer, isGood] of evalResults) {
      if (isGood) goodAnswers.push(answer);
      else badAnswers.push(answer);
    }

    log(`[${tag}] ✓ Quality: ${goodAnswers.length} good, ${badAnswers.length} bad`);
    judgeDetail.goodAnswers = goodAnswers.map((a) => a.id);

    let answerRankings: string[];
    let goodAnswerIds: string[];

    // Step 5: Build ranking
    if (goodAnswers.length <= 1) {
      const rankedGoodIds = goodAnswers.map((a) => a.id);
      const rankedBadIds = badAnswers.map((a) => a.id);
      answerRankings = [...rankedGoodIds, ...rankedBadIds];
      goodAnswerIds = rankedGoodIds;
    } else {
      const n = goodAnswers.length;
      const wins: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
      const pairs = buildPairwisePairs(n);

      log(`[${tag}] ↳ Running ${pairs.length} pairwise comparisons...`);
      judgeDetail.phase = "comparing";
      judgeDetail.totalComparisons = pairs.length;
      viewerBus.setJudgeDetail(judgeDetail);

      let cmpDone = 0;
      const cmpTotal = pairs.length;
      const compareResults = await mapWithConcurrency(
        pairs,
        concurrency,
        async ([aIdx, bIdx]): Promise<[number, number, string | null]> => {
          const result = await llm.comparePairwise(
            problem,
            goodAnswers[aIdx].decrypted_content!,
            goodAnswers[bIdx].decrypted_content!,
            RANKING_LLM_RETRIES,
            AbortSignal.timeout(60_000),
          );
          cmpDone++;
          const winner = result === "A" ? `#${aIdx + 1} wins` : result === "B" ? `#${bIdx + 1} wins` : result === "U" ? "tie" : "skip";
          log(`[${tag}] ↳ Compare ${cmpDone}/${cmpTotal} (#${aIdx + 1} vs #${bIdx + 1}) → ${winner}`);
          judgeDetail.comparisons.push({
            a: goodAnswers[aIdx].id,
            b: goodAnswers[bIdx].id,
            winner: result ?? "U",
          });
          judgeDetail.comparisonIndex = cmpDone;
          judgeDetail.currentPairA = goodAnswers[aIdx].id;
          judgeDetail.currentPairB = goodAnswers[bIdx].id;
          viewerBus.setJudgeDetail(judgeDetail);
          return [aIdx, bIdx, result];
        },
      );

      for (const [aIdx, bIdx, result] of compareResults) {
        if (result === null) continue;
        if (result === "A") wins[aIdx][bIdx] += 1;
        else if (result === "B") wins[bIdx][aIdx] += 1;
        else if (result === "U") {
          wins[aIdx][bIdx] += 0.5;
          wins[bIdx][aIdx] += 0.5;
        }
      }

      // Step 6: Run local Bradley-Terry
      judgeDetail.phase = "ranking_all";
      viewerBus.setJudgeDetail(judgeDetail);

      const strengths = computeBradleyTerry(wins);
      const indexed = strengths
        .map((s, i) => ({ idx: i, strength: s }))
        .sort((a, b) => b.strength - a.strength);

      const ranking = indexed.map((x) => `#${x.idx + 1}:${x.strength.toFixed(2)}`).join(" > ");
      log(`[${tag}] ✓ BT ranking: ${ranking}`);

      for (const x of indexed) {
        judgeDetail.scores[goodAnswers[x.idx].id] = x.strength;
      }

      const rankedGoodIds = indexed.map((x) => goodAnswers[x.idx].id);
      const rankedBadIds = badAnswers.map((a) => a.id);
      answerRankings = [...rankedGoodIds, ...rankedBadIds];
      goodAnswerIds = goodAnswers.map((a) => a.id);
    }

    // Step 7: Submit vote
    judgeDetail.phase = "submitting";
    judgeDetail.finalRankings = answerRankings;
    judgeDetail.goodAnswers = goodAnswerIds;
    viewerBus.setJudgeDetail(judgeDetail);

    log(`[${tag}] ↳ Submitting vote with ${answerRankings.length} ranked answers...`);
    const voteResult = await client.submitVote(challengeId, answerRankings, goodAnswerIds);
    log(`[${tag}] ✓ Vote submitted! vote_id=${voteResult.vote_id ?? "?"}`);

    judgeDetail.phase = "done";
    viewerBus.setJudgeDetail(judgeDetail);
    viewerBus.updateStats({ judgments: (viewerBus.stats.judgments || 0) + 1 });
  } finally {
    unpinTask(challengeId);
  }
}
