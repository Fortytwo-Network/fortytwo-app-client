import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLlm, mockBus, mockUtils } = vi.hoisted(() => ({
  mockLlm: {
    generateAnswer: vi.fn().mockResolvedValue("Yes"),
  },
  mockBus: {
    setState: vi.fn(),
    setChallengeRoundsAvailable: vi.fn(),
  },
  mockUtils: {
    log: vi.fn(),
    pinTask: vi.fn(),
    unpinTask: vi.fn(),
  },
}));

vi.mock("../src/llm.js", () => mockLlm);
vi.mock("../src/event-bus.js", () => ({ viewerBus: mockBus }));
vi.mock("../src/utils.js", () => mockUtils);

vi.mock("../src/api-client.js", () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    ApiError: MockApiError,
    FortyTwoClient: class {},
  };
});

import {
  processChallengeRounds,
  createChallengeContext,
} from "../src/capability-challenge.js";

// In 2026-04-13 the test is pinned to a future ends_at
const FAR_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const NEAR_FUTURE = new Date(Date.now() + 5_000).toISOString();

function buildRound(overrides: Record<string, any> = {}) {
  return {
    id: "round-aaaaaaaa",
    foundation_pool_id: "fp-1",
    // content is hidden in listing; revealed after join.
    status: "active",
    starts_at: new Date(Date.now() - 1000).toISOString(),
    ends_at: FAR_FUTURE,
    for_budget_total: "100",
    max_participants: 20,
    joined_count: 5,
    slots_remaining: 15,
    has_joined: false,
    has_answered: false,
    settled_at: null,
    winners_count: 0,
    reward_per_winner: "10",
    created_at: new Date(Date.now() - 1000).toISOString(),
    answer_count: 0,
    ...overrides,
  };
}

function makeClient(partial: Record<string, any> = {}) {
  return {
    listActiveChallengeRounds: vi.fn().mockResolvedValue({
      items: [], total: 0, page: 1, page_size: 20,
    }),
    getChallengeRound: vi.fn().mockResolvedValue({
      id: "round-aaaaaaaa",
      content: "Detail question?",
    }),
    joinChallengeRound: vi.fn().mockResolvedValue({
      id: "round-aaaaaaaa",
      content: "Is sky blue?",
      stake_amount: "10",
      participant_id: "p-1",
    }),
    submitChallengeAnswer: vi.fn().mockResolvedValue({
      id: "ans-1",
      round_id: "round-aaaaaaaa",
      agent_id: "agent-1",
      content: "Yes",
      is_correct: null,
      capability_delta: 0,
      staked_amount: "10",
      reward_amount: "0",
      submitted_at: new Date().toISOString(),
      validated_at: null,
    }),
    ...partial,
  } as any;
}

describe("processChallengeRounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 with no side effects when no rounds", async () => {
    const client = makeClient();
    const ctx = createChallengeContext(client);
    const count = await processChallengeRounds(ctx);
    expect(count).toBe(0);
    expect(mockLlm.generateAnswer).not.toHaveBeenCalled();
    expect(client.submitChallengeAnswer).not.toHaveBeenCalled();
    expect(mockBus.setChallengeRoundsAvailable).toHaveBeenCalledWith(0);
  });

  it("filters out already-answered rounds", async () => {
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [buildRound({ has_answered: true })],
        total: 1,
        page: 1,
        page_size: 20,
      }),
    });
    const ctx = createChallengeContext(client);
    const count = await processChallengeRounds(ctx);
    expect(count).toBe(0);
    expect(mockLlm.generateAnswer).not.toHaveBeenCalled();
    expect(client.submitChallengeAnswer).not.toHaveBeenCalled();
    expect(mockBus.setChallengeRoundsAvailable).toHaveBeenCalledWith(0);
  });

  it("filters out non-active rounds", async () => {
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [buildRound({ status: "settled" })],
        total: 1,
        page: 1,
        page_size: 20,
      }),
    });
    const ctx = createChallengeContext(client);
    const count = await processChallengeRounds(ctx);
    expect(count).toBe(0);
    expect(mockLlm.generateAnswer).not.toHaveBeenCalled();
  });

  it("skips rounds already in-flight", async () => {
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [buildRound({ id: "busy-round" })],
        total: 1,
        page: 1,
        page_size: 20,
      }),
    });
    const ctx = createChallengeContext(client);
    ctx.inFlight.add("busy-round");
    const count = await processChallengeRounds(ctx);
    expect(count).toBe(0);
    expect(mockLlm.generateAnswer).not.toHaveBeenCalled();
    expect(client.submitChallengeAnswer).not.toHaveBeenCalled();
    // busy-round was already there; processChallengeRounds must not delete
    // entries it did not add itself.
    expect(ctx.inFlight.has("busy-round")).toBe(true);
  });

  it("skips rounds whose deadline is less than 30s away", async () => {
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [buildRound({ ends_at: NEAR_FUTURE })],
        total: 1,
        page: 1,
        page_size: 20,
      }),
    });
    const ctx = createChallengeContext(client);
    const count = await processChallengeRounds(ctx);
    // Attempted, but work inside answerChallengeRound early-returns.
    expect(count).toBe(1);
    expect(mockLlm.generateAnswer).not.toHaveBeenCalled();
    expect(client.submitChallengeAnswer).not.toHaveBeenCalled();
    expect(ctx.inFlight.size).toBe(0);
  });

  it("joins round, gets content, generates answer, and submits (new server)", async () => {
    const round = buildRound(); // content hidden
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [round], total: 1, page: 1, page_size: 20,
      }),
    });
    const ctx = createChallengeContext(client);

    const count = await processChallengeRounds(ctx);

    expect(count).toBe(1);
    expect(client.joinChallengeRound).toHaveBeenCalledWith(round.id);
    expect(mockLlm.generateAnswer).toHaveBeenCalledTimes(1);
    expect(mockLlm.generateAnswer).toHaveBeenCalledWith(
      expect.stringContaining("logic puzzle"),
      "Is sky blue?", // from joinChallengeRound mock
    );
    expect(client.submitChallengeAnswer).toHaveBeenCalledWith(round.id, "Yes");
    expect(ctx.inFlight.size).toBe(0);
  });

  it("fetches content via getChallengeRound when already joined (no re-stake)", async () => {
    const round = buildRound({ has_joined: true });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [round], total: 1, page: 1, page_size: 20,
      }),
      getChallengeRound: vi.fn().mockResolvedValue({
        id: round.id, content: "Resumed question",
      }),
    });
    const ctx = createChallengeContext(client);

    await processChallengeRounds(ctx);

    expect(client.joinChallengeRound).not.toHaveBeenCalled();
    expect(client.getChallengeRound).toHaveBeenCalledWith(round.id);
    expect(mockLlm.generateAnswer).toHaveBeenCalledWith(
      expect.any(String),
      "Resumed question",
    );
    expect(client.submitChallengeAnswer).toHaveBeenCalled();
  });

  it("falls back to detail on 'Already joined' race", async () => {
    const round = buildRound({ has_joined: false });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [round], total: 1, page: 1, page_size: 20,
      }),
      joinChallengeRound: vi.fn().mockRejectedValue(new Error("Already joined this round")),
      getChallengeRound: vi.fn().mockResolvedValue({ id: round.id, content: "Race content" }),
    });
    const ctx = createChallengeContext(client);

    await processChallengeRounds(ctx);

    expect(client.joinChallengeRound).toHaveBeenCalledTimes(1);
    expect(client.getChallengeRound).toHaveBeenCalledWith(round.id);
    expect(mockLlm.generateAnswer).toHaveBeenCalledWith(
      expect.any(String),
      "Race content",
    );
    expect(client.submitChallengeAnswer).toHaveBeenCalled();
  });

  it("breaks the loop on Insufficient FOR balance (stops wasting requests)", async () => {
    const r1 = buildRound({ id: "r1" });
    const r2 = buildRound({ id: "r2" });
    const r3 = buildRound({ id: "r3" });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [r1, r2, r3], total: 3, page: 1, page_size: 20,
      }),
      joinChallengeRound: vi.fn()
        .mockResolvedValueOnce({ content: "Q1", stake_amount: "10" })
        .mockRejectedValueOnce(new Error("Insufficient FOR balance: need 10, have 0")),
    });
    const ctx = createChallengeContext(client);

    await processChallengeRounds(ctx);

    // r1 joined+answered; r2 join failed → break; r3 untouched.
    expect(client.joinChallengeRound).toHaveBeenCalledTimes(2);
    expect(client.submitChallengeAnswer).toHaveBeenCalledTimes(1);
    expect(mockUtils.log).toHaveBeenCalledWith(
      expect.stringContaining("challenge_locked FOR exhausted"),
    );
  });

  it("breaks the loop on LLM failure (prevents staking on unanswerable rounds)", async () => {
    const r1 = buildRound({ id: "r1" });
    const r2 = buildRound({ id: "r2" });
    const r3 = buildRound({ id: "r3" });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [r1, r2, r3], total: 3, page: 1, page_size: 20,
      }),
    });
    mockLlm.generateAnswer.mockRejectedValueOnce(new Error("Connection refused — local inference down"));
    const ctx = createChallengeContext(client);

    await processChallengeRounds(ctx);

    // r1 joined, LLM failed → break. r2/r3 must NOT be joined (FOR not burned).
    expect(client.joinChallengeRound).toHaveBeenCalledTimes(1);
    expect(client.submitChallengeAnswer).not.toHaveBeenCalled();
    expect(mockUtils.log).toHaveBeenCalledWith(
      expect.stringContaining("Inference unavailable"),
    );
  });

  it("filters out full rounds (slots_remaining = 0)", async () => {
    const round = buildRound({ slots_remaining: 0 });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [round], total: 1, page: 1, page_size: 20,
      }),
    });
    const ctx = createChallengeContext(client);
    const count = await processChallengeRounds(ctx);
    expect(count).toBe(0);
    expect(client.joinChallengeRound).not.toHaveBeenCalled();
  });

  it("keeps processing subsequent rounds after a submit error", async () => {
    const goodRound = buildRound({ id: "good-round" });
    const badRound = buildRound({ id: "bad-round" });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [badRound, goodRound], total: 2, page: 1, page_size: 20,
      }),
      joinChallengeRound: vi.fn().mockResolvedValue({
        content: "Q?", stake_amount: "10", participant_id: "p",
      }),
      submitChallengeAnswer: vi.fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ id: "ans-good", staked_amount: "10" }),
    });
    const ctx = createChallengeContext(client);

    const count = await processChallengeRounds(ctx);

    expect(count).toBe(2);
    expect(client.submitChallengeAnswer).toHaveBeenCalledTimes(2);
    expect(ctx.inFlight.size).toBe(0);
    expect(mockUtils.log).toHaveBeenCalledWith(expect.stringContaining("failed"));
  });

  it("stops processing further rounds once the node transitions to Capable mid-cycle", async () => {
    const r1 = buildRound({ id: "r1" });
    const r2 = buildRound({ id: "r2" });
    const r3 = buildRound({ id: "r3" });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [r1, r2, r3], total: 3, page: 1, page_size: 20,
      }),
      joinChallengeRound: vi.fn().mockResolvedValue({
        content: "Q?", stake_amount: "10", participant_id: "p",
      }),
      submitChallengeAnswer: vi.fn()
        .mockResolvedValueOnce({ id: "ans-1", staked_amount: "10" }) // r1 succeeds
        .mockRejectedValueOnce(new Error("Capable nodes cannot participate in Capability Challenge rounds")) // r2 tier mismatch
        .mockResolvedValueOnce({ id: "ans-3", staked_amount: "10" }), // r3 — should NOT be reached
    });
    const ctx = createChallengeContext(client);

    const count = await processChallengeRounds(ctx);

    // Attempted r1 + r2, aborted before r3.
    expect(count).toBe(2);
    expect(client.submitChallengeAnswer).toHaveBeenCalledTimes(2);
    expect(ctx.inFlight.size).toBe(0);
    expect(mockUtils.log).toHaveBeenCalledWith(
      expect.stringContaining("Reached Capability 42"),
    );
  });

  it("breaks on tier-mismatch error message from join", async () => {
    const r1 = buildRound({ id: "r1" });
    const r2 = buildRound({ id: "r2" });
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockResolvedValue({
        items: [r1, r2], total: 2, page: 1, page_size: 20,
      }),
      joinChallengeRound: vi.fn().mockRejectedValue(
        new Error("Capable nodes cannot participate in Capability Challenge rounds"),
      ),
    });
    const ctx = createChallengeContext(client);

    await processChallengeRounds(ctx);

    expect(client.joinChallengeRound).toHaveBeenCalledTimes(1);
    expect(client.submitChallengeAnswer).not.toHaveBeenCalled();
  });

  it("propagates listActiveChallengeRounds errors", async () => {
    const client = makeClient({
      listActiveChallengeRounds: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const ctx = createChallengeContext(client);
    await expect(processChallengeRounds(ctx)).rejects.toThrow("boom");
  });
});
