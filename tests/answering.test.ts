import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    llm_timeout: 60,
    answerer_system_prompt: "You are a helpful assistant.",
  }),
}));

import { computeEffectiveAnswerDeadline } from "../src/answering.js";

describe("computeEffectiveAnswerDeadline", () => {
  it("uses answering_grace_ends_at when present", () => {
    const graceEnds = new Date(Date.now() + 120_000).toISOString();
    const result = computeEffectiveAnswerDeadline({
      answering_grace_ends_at: graceEnds,
      answer_deadline_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(result).toBeGreaterThan(115);
    expect(result).toBeLessThanOrEqual(120);
  });

  it("computes answer_deadline + grace when no grace_ends_at", () => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const result = computeEffectiveAnswerDeadline({
      answer_deadline_at: deadline,
      extra_completion_duration_answers_seconds: 300,
    });
    // 60 + 300 = 360 seconds from now
    expect(result).toBeGreaterThan(355);
    expect(result).toBeLessThanOrEqual(360);
  });

  it("defaults grace to 300 seconds", () => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const result = computeEffectiveAnswerDeadline({
      answer_deadline_at: deadline,
    });
    expect(result).toBeGreaterThan(355);
    expect(result).toBeLessThanOrEqual(360);
  });

  it("returns 0 for empty/invalid deadline", () => {
    expect(computeEffectiveAnswerDeadline({})).toBe(0);
    expect(computeEffectiveAnswerDeadline({ answer_deadline_at: "invalid" })).toBe(0);
  });
});
