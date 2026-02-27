import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    llm_timeout: 120,
    llm_concurrency: 20,
  }),
  BT_MAX_ITERATIONS: 1000,
  BT_CONVERGENCE_THRESHOLD: 1e-6,
  MIN_DEADLINE_SECONDS: 300,
}));

vi.mock("../src/llm.js", () => ({
  evaluateGoodEnough: vi.fn().mockResolvedValue(true),
  comparePairwise: vi.fn().mockResolvedValue("A"),
}));

vi.mock("../src/utils.js", () => ({
  log: vi.fn(),
  mapWithConcurrency: vi.fn(async (items: any[], _limit: number, fn: Function) => {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await fn(items[i], i));
    }
    return results;
  }),
  pinTask: vi.fn(),
  unpinTask: vi.fn(),
}));

import { buildPairwisePairs, computeBradleyTerry, estimateLlmTime, judgeChallenge } from "../src/judging.js";
import * as llm from "../src/llm.js";
import { pinTask, unpinTask } from "../src/utils.js";

function makeClient(overrides: Record<string, any> = {}) {
  return {
    joinChallenge: vi.fn().mockResolvedValue({ stake_amount: "1.0" }),
    getChallenge: vi.fn().mockResolvedValue({ decrypted_query_content: "What is 2+2?" }),
    getChallengeAnswers: vi.fn().mockResolvedValue({
      answers: [
        { id: "a1", decrypted_content: "4" },
        { id: "a2", decrypted_content: "5" },
      ],
    }),
    submitVote: vi.fn().mockResolvedValue({ vote_id: "v1" }),
    ...overrides,
  } as any;
}

describe("buildPairwisePairs", () => {
  it("returns empty for n < 2", () => {
    expect(buildPairwisePairs(0)).toEqual([]);
    expect(buildPairwisePairs(1)).toEqual([]);
  });

  it("returns correct pairs for n=2", () => {
    const pairs = buildPairwisePairs(2);
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([1, 0]);
  });

  it("includes cross-chain pairs for n=4", () => {
    const pairs = buildPairwisePairs(4);
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([1, 2]);
    expect(pairs).toContainEqual([2, 3]);
    expect(pairs).toContainEqual([0, 2]);
    expect(pairs).toContainEqual([2, 0]);
    expect(pairs).toContainEqual([1, 3]);
    expect(pairs).toContainEqual([3, 1]);
  });

  it("all pairs have valid indices", () => {
    const n = 6;
    const pairs = buildPairwisePairs(n);
    for (const [a, b] of pairs) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(n);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(n);
      expect(a).not.toBe(b);
    }
  });
});

describe("computeBradleyTerry", () => {
  it("returns empty for empty wins", () => {
    expect(computeBradleyTerry([])).toEqual([]);
  });

  it("returns [1.0] for single item", () => {
    expect(computeBradleyTerry([[0]])).toEqual([1.0]);
  });

  it("ranks dominant player higher", () => {
    const wins = [[0, 5], [0, 0]];
    const strengths = computeBradleyTerry(wins);
    expect(strengths[0]).toBeGreaterThan(strengths[1]);
  });

  it("produces equal strengths for symmetric wins", () => {
    const wins = [[0, 3], [3, 0]];
    const strengths = computeBradleyTerry(wins);
    expect(Math.abs(strengths[0] - strengths[1])).toBeLessThan(0.01);
  });

  it("handles 3 players with clear ordering", () => {
    const wins = [[0, 5, 5], [0, 0, 5], [0, 0, 0]];
    const strengths = computeBradleyTerry(wins);
    expect(strengths[0]).toBeGreaterThan(strengths[1]);
    expect(strengths[1]).toBeGreaterThan(strengths[2]);
  });

  it("handles fractional wins", () => {
    const wins = [[0, 2.5], [2.5, 0]];
    const strengths = computeBradleyTerry(wins);
    expect(Math.abs(strengths[0] - strengths[1])).toBeLessThan(0.01);
  });
});

describe("estimateLlmTime", () => {
  it("returns 0 for 0 answers", () => {
    expect(estimateLlmTime(0)).toBe(0);
  });

  it("returns > 0 for 1 answer", () => {
    expect(estimateLlmTime(1)).toBeGreaterThan(0);
  });

  it("increases with more answers", () => {
    expect(estimateLlmTime(5)).toBeLessThan(estimateLlmTime(10));
  });
});

describe("judgeChallenge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes full judging flow with 2 good answers", async () => {
    vi.mocked(llm.evaluateGoodEnough).mockResolvedValue(true);
    vi.mocked(llm.comparePairwise).mockResolvedValue("A");
    const client = makeClient();
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(client.joinChallenge).toHaveBeenCalled();
    expect(client.getChallenge).toHaveBeenCalled();
    expect(client.getChallengeAnswers).toHaveBeenCalled();
    expect(llm.evaluateGoodEnough).toHaveBeenCalledTimes(2);
    expect(client.submitVote).toHaveBeenCalled();
    expect(pinTask).toHaveBeenCalled();
    expect(unpinTask).toHaveBeenCalled();
  });

  it("skips when time budget exceeded", async () => {
    const client = makeClient();
    await judgeChallenge(client, "ch12345678901234567890123456789012", 10, 50);
    expect(client.joinChallenge).not.toHaveBeenCalled();
  });

  it("skips when challenge is full", async () => {
    const client = makeClient({
      joinChallenge: vi.fn().mockRejectedValue(new Error("maximum participants")),
    });
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(client.getChallenge).not.toHaveBeenCalled();
  });

  it("proceeds when already joined", async () => {
    const client = makeClient({
      joinChallenge: vi.fn().mockRejectedValue(new Error("already joined")),
    });
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(client.getChallenge).toHaveBeenCalled();
    expect(client.submitVote).toHaveBeenCalled();
  });

  it("throws on unknown join error", async () => {
    const client = makeClient({
      joinChallenge: vi.fn().mockRejectedValue(new Error("network error")),
    });
    await expect(judgeChallenge(client, "ch12345678901234567890123456789012", 9999)).rejects.toThrow("network error");
  });

  it("throws on missing decrypted_query_content", async () => {
    const client = makeClient({
      getChallenge: vi.fn().mockResolvedValue({}),
    });
    await expect(judgeChallenge(client, "ch12345678901234567890123456789012", 9999)).rejects.toThrow("No decrypted query content");
  });

  it("throws on empty answers", async () => {
    const client = makeClient({
      getChallengeAnswers: vi.fn().mockResolvedValue({ answers: [] }),
    });
    await expect(judgeChallenge(client, "ch12345678901234567890123456789012", 9999)).rejects.toThrow("No answers");
  });

  it("ranks 1 good + 1 bad — no pairwise", async () => {
    vi.mocked(llm.evaluateGoodEnough).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const client = makeClient();
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(llm.comparePairwise).not.toHaveBeenCalled();
    const args = client.submitVote.mock.calls[0];
    expect(args[1]).toEqual(["a1", "a2"]);
    expect(args[2]).toEqual(["a1"]);
  });

  it("handles all bad answers — no pairwise", async () => {
    vi.mocked(llm.evaluateGoodEnough).mockResolvedValue(false);
    const client = makeClient();
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(llm.comparePairwise).not.toHaveBeenCalled();
    const args = client.submitVote.mock.calls[0];
    expect(args[2]).toEqual([]);
  });

  it("handles empty decrypted_content as bad", async () => {
    const client = makeClient({
      getChallengeAnswers: vi.fn().mockResolvedValue({
        answers: [
          { id: "a1", decrypted_content: "" },
          { id: "a2", decrypted_content: "good" },
        ],
      }),
    });
    vi.mocked(llm.evaluateGoodEnough).mockResolvedValue(true);
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(client.submitVote).toHaveBeenCalled();
  });

  it("handles pairwise 'U' result as half-wins", async () => {
    vi.mocked(llm.evaluateGoodEnough).mockResolvedValue(true);
    vi.mocked(llm.comparePairwise).mockResolvedValue("U");
    const client = makeClient();
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(llm.comparePairwise).toHaveBeenCalled();
    expect(client.submitVote).toHaveBeenCalled();
  });

  it("handles pairwise null result (LLM failure)", async () => {
    vi.mocked(llm.evaluateGoodEnough).mockResolvedValue(true);
    vi.mocked(llm.comparePairwise).mockResolvedValue(null as any);
    const client = makeClient();
    await judgeChallenge(client, "ch12345678901234567890123456789012", 9999);
    expect(client.submitVote).toHaveBeenCalled();
  });
});
