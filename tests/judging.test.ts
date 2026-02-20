import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    llm_timeout: 120,
    llm_concurrency: 20,
  }),
  BT_MAX_ITERATIONS: 1000,
  BT_CONVERGENCE_THRESHOLD: 1e-6,
  MIN_DEADLINE_SECONDS: 300,
}));

import { buildPairwisePairs, computeBradleyTerry, estimateLlmTime } from "../src/judging.js";

describe("buildPairwisePairs", () => {
  it("returns empty for n < 2", () => {
    expect(buildPairwisePairs(0)).toEqual([]);
    expect(buildPairwisePairs(1)).toEqual([]);
  });

  it("returns correct pairs for n=2", () => {
    const pairs = buildPairwisePairs(2);
    // Chain 1: (0,1),(1,0) — Chain 2: (0,1),(1,0)
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([1, 0]);
  });

  it("includes cross-chain pairs for n=4", () => {
    const pairs = buildPairwisePairs(4);

    // Chain 1 adjacent: (0,1),(1,0),(1,2),(2,1),(2,3),(3,2)
    expect(pairs).toContainEqual([0, 1]);
    expect(pairs).toContainEqual([1, 2]);
    expect(pairs).toContainEqual([2, 3]);

    // Chain 2 cross: (0,2),(2,0),(1,3),(3,1)
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
    // Player 0 beats player 1 every time
    const wins = [
      [0, 5],
      [0, 0],
    ];
    const strengths = computeBradleyTerry(wins);
    expect(strengths[0]).toBeGreaterThan(strengths[1]);
  });

  it("produces equal strengths for symmetric wins", () => {
    const wins = [
      [0, 3],
      [3, 0],
    ];
    const strengths = computeBradleyTerry(wins);
    expect(Math.abs(strengths[0] - strengths[1])).toBeLessThan(0.01);
  });

  it("handles 3 players with clear ordering", () => {
    // 0 > 1 > 2
    const wins = [
      [0, 5, 5],
      [0, 0, 5],
      [0, 0, 0],
    ];
    const strengths = computeBradleyTerry(wins);
    expect(strengths[0]).toBeGreaterThan(strengths[1]);
    expect(strengths[1]).toBeGreaterThan(strengths[2]);
  });

  it("handles fractional wins (uncertainty)", () => {
    const wins = [
      [0, 2.5],
      [2.5, 0],
    ];
    const strengths = computeBradleyTerry(wins);
    expect(Math.abs(strengths[0] - strengths[1])).toBeLessThan(0.01);
  });
});

describe("estimateLlmTime", () => {
  it("returns 0 for 0 or 1 answers", () => {
    // 0 answers: no pairwise, but 0 good-enough evals
    expect(estimateLlmTime(0)).toBe(0);
    // 1 answer: 1 good-enough eval, no pairwise
    expect(estimateLlmTime(1)).toBeGreaterThan(0);
  });

  it("increases with more answers", () => {
    expect(estimateLlmTime(5)).toBeLessThan(estimateLlmTime(10));
  });
});
