import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    llm_timeout: 120,
    answerer_system_prompt: "You are a helpful assistant.",
  }),
}));

vi.mock("../src/llm.js", () => ({
  generateAnswer: vi.fn().mockResolvedValue("the answer"),
}));

vi.mock("../src/utils.js", () => ({
  log: vi.fn(),
  pinTask: vi.fn(),
  unpinTask: vi.fn(),
}));

import { computeEffectiveAnswerDeadline, answerQuery } from "../src/answering.js";
import * as llm from "../src/llm.js";
import { pinTask, unpinTask } from "../src/utils.js";

function makeClient(overrides: Record<string, any> = {}) {
  return {
    getQuery: vi.fn().mockResolvedValue({
      has_answered: false,
      has_joined: false,
      status: "active",
      answer_deadline_at: new Date(Date.now() + 600_000).toISOString(),
      extra_completion_duration_answers_seconds: 300,
      decrypted_content: "What is 2+2?",
    }),
    joinQuery: vi.fn().mockResolvedValue({ stake_amount: "1.0" }),
    submitAnswer: vi.fn().mockResolvedValue({ id: "answer-1" }),
    ...overrides,
  } as any;
}

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
    expect(result).toBeGreaterThan(355);
    expect(result).toBeLessThanOrEqual(360);
  });

  it("defaults grace to 300 seconds", () => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const result = computeEffectiveAnswerDeadline({ answer_deadline_at: deadline });
    expect(result).toBeGreaterThan(355);
    expect(result).toBeLessThanOrEqual(360);
  });

  it("returns 0 for empty/invalid deadline", () => {
    expect(computeEffectiveAnswerDeadline({})).toBe(0);
    expect(computeEffectiveAnswerDeadline({ answer_deadline_at: "invalid" })).toBe(0);
  });

  it("returns 0 on exception in secondsUntil (non-string grace_ends_at)", () => {
    expect(computeEffectiveAnswerDeadline({ answering_grace_ends_at: 12345 })).toBe(0);
  });

  it("returns 0 on exception in deadline parse (non-string deadline)", () => {
    expect(computeEffectiveAnswerDeadline({ answer_deadline_at: 12345 })).toBe(0);
  });
});

describe("answerQuery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes full answer flow", async () => {
    const client = makeClient();
    await answerQuery(client, "q1234567-1234-1234-1234-123456789012");
    expect(client.joinQuery).toHaveBeenCalled();
    expect(llm.generateAnswer).toHaveBeenCalled();
    expect(client.submitAnswer).toHaveBeenCalled();
    expect(pinTask).toHaveBeenCalled();
    expect(unpinTask).toHaveBeenCalled();
  });

  it("skips already answered queries", async () => {
    const client = makeClient({
      getQuery: vi.fn().mockResolvedValue({ has_answered: true }),
    });
    await answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012");
    expect(client.joinQuery).not.toHaveBeenCalled();
  });

  it("skips when deadline passed", async () => {
    const client = makeClient({
      getQuery: vi.fn().mockResolvedValue({
        has_answered: false,
        status: "active",
        answer_deadline_at: new Date(Date.now() - 600_000).toISOString(),
      }),
    });
    await answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012");
    expect(client.joinQuery).not.toHaveBeenCalled();
  });

  it("skips when not enough time", async () => {
    const client = makeClient({
      getQuery: vi.fn().mockResolvedValue({
        has_answered: false,
        status: "active",
        answer_deadline_at: new Date(Date.now() + 10_000).toISOString(),
        extra_completion_duration_answers_seconds: 0,
      }),
    });
    await answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012");
    expect(client.joinQuery).not.toHaveBeenCalled();
  });

  it("skips non-active status", async () => {
    const client = makeClient({
      getQuery: vi.fn().mockResolvedValue({
        has_answered: false,
        status: "completed",
        answer_deadline_at: new Date(Date.now() + 600_000).toISOString(),
        extra_completion_duration_answers_seconds: 300,
      }),
    });
    await answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012");
    expect(client.joinQuery).not.toHaveBeenCalled();
  });

  it("skips full query on join", async () => {
    const client = makeClient({
      joinQuery: vi.fn().mockRejectedValue(new Error("maximum participants reached")),
      getQuery: vi.fn().mockResolvedValue({
        has_answered: false,
        has_joined: false,
        status: "active",
        answer_deadline_at: new Date(Date.now() + 600_000).toISOString(),
        extra_completion_duration_answers_seconds: 300,
        decrypted_content: "test",
      }),
    });
    await answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012");
    expect(client.submitAnswer).not.toHaveBeenCalled();
  });

  it("proceeds when already joined via flag", async () => {
    const client = makeClient({
      getQuery: vi.fn().mockResolvedValue({
        has_answered: false,
        has_joined: true,
        status: "active",
        answer_deadline_at: new Date(Date.now() + 600_000).toISOString(),
        extra_completion_duration_answers_seconds: 300,
        decrypted_content: "What is 2+2?",
      }),
    });
    await answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012");
    expect(client.joinQuery).not.toHaveBeenCalled();
    expect(client.submitAnswer).toHaveBeenCalled();
  });

  it("handles already joined error on join", async () => {
    const client = makeClient({
      joinQuery: vi.fn().mockRejectedValue(new Error("already joined")),
    });
    await answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012");
    expect(client.submitAnswer).toHaveBeenCalled();
  });

  it("throws on missing decrypted_content", async () => {
    const client = makeClient({
      getQuery: vi.fn().mockResolvedValue({
        has_answered: false,
        has_joined: true,
        status: "active",
        answer_deadline_at: new Date(Date.now() + 600_000).toISOString(),
        extra_completion_duration_answers_seconds: 300,
      }),
    });
    await expect(answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012")).rejects.toThrow("No decrypted content");
  });

  it("throws on unknown join error", async () => {
    const client = makeClient({
      joinQuery: vi.fn().mockRejectedValue(new Error("network error")),
      getQuery: vi.fn().mockResolvedValue({
        has_answered: false,
        has_joined: false,
        status: "active",
        answer_deadline_at: new Date(Date.now() + 600_000).toISOString(),
        extra_completion_duration_answers_seconds: 300,
        decrypted_content: "test",
      }),
    });
    await expect(answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012")).rejects.toThrow("network error");
  });

  it("handles LLM timeout gracefully", async () => {
    vi.mocked(llm.generateAnswer).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      throw new Error("aborted");
    });
    const client = makeClient();
    // The timeout is controlled by llm_timeout config (120s) so this won't actually timeout in test
    // Instead, simulate the abort path: generateAnswer throws after abort
    await expect(answerQuery(client, "q1234567-aaaa-bbbb-cccc-123456789012")).rejects.toThrow("aborted");
  });
});
