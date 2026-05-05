import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCfg: Record<string, any> = {
  inference_type: "openrouter",
  openrouter_api_key: "test-key",
  fortytwo_api_base: "https://api.test.com",
  identity_file: "identity.json",
  poll_interval: 1,
  model_name: "test-model",
  llm_concurrency: 5,
  llm_timeout: 10,
  min_balance: 5.0,
  node_role: "JUDGE",
  answerer_system_prompt: "You are a helpful assistant.",
};

vi.mock("../src/config.js", () => ({
  get: () => mockCfg,
  MIN_DEADLINE_SECONDS: 300,
}));

const mockClient = {
  nodeId: "agent-1",
  login: vi.fn().mockResolvedValue({}),
  getPendingChallenges: vi.fn().mockResolvedValue({ challenges: [] }),
  getActiveQueries: vi.fn().mockResolvedValue({ queries: [] }),
  getBalance: vi.fn().mockResolvedValue({ available: "100.0" }),
  getCapability: vi.fn().mockResolvedValue({
    agent_id: "agent-1",
    capability_rank: 42,
    node_tier: "capable",
    is_dead_locked: false,
  }),
  getAgent: vi.fn().mockResolvedValue({ profile: {}, capability_rank: 42, node_tier: "capable" }),
  getAgentStats: vi.fn().mockResolvedValue({}),
};

vi.mock("../src/api-client.js", () => {
  class MockFortyTwoClient {
    nodeId = mockClient.nodeId;
    login = mockClient.login;
    getPendingChallenges = mockClient.getPendingChallenges;
    getActiveQueries = mockClient.getActiveQueries;
    getBalance = mockClient.getBalance;
    getCapability = mockClient.getCapability;
    getAgent = mockClient.getAgent;
    getAgentStats = mockClient.getAgentStats;
  }
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { FortyTwoClient: MockFortyTwoClient, ApiError: MockApiError };
});

vi.mock("../src/identity.js", () => ({
  loadIdentity: vi.fn().mockReturnValue({ node_id: "agent-1", node_secret: "sec" }),
  resetAccount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/judging.js", () => ({
  judgeChallenge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/answering.js", () => ({
  answerQuery: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/llm.js", () => ({
  isLlmBusy: vi.fn().mockReturnValue(false),
  pingLlm: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/setup-logic.js", () => ({
  validateModel: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../src/capability-challenge.js", () => {
  class LlmFailureError extends Error {
    constructor(cause: Error) {
      super(`LLM generation failed: ${cause.message}`);
      this.name = "LlmFailureError";
    }
  }
  return {
    createChallengeContext: vi.fn(() => ({ client: {}, inFlight: new Set() })),
    processChallengeRounds: vi.fn().mockResolvedValue(0),
    LlmFailureError,
  };
});

vi.mock("../src/utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  secondsUntilDeadline: vi.fn().mockReturnValue(600),
  setVerbose: vi.fn(),
  log: vi.fn(),
  getRoleLabel: vi.fn((v) => v),
}));

import {
  checkBalance,
  fetchCapability,
  processChallenges,
  processQueries,
  runCycle,
  getTaskStats,
  main,
} from "../src/main.js";
import { loadIdentity } from "../src/identity.js";
import { isLlmBusy, pingLlm } from "../src/llm.js";
import { secondsUntilDeadline, log } from "../src/utils.js";
import { processChallengeRounds } from "../src/capability-challenge.js";

const CAPABLE = { agent_id: "a", capability_rank: 42, node_tier: "capable", is_dead_locked: false } as const;
const CHALLENGER = { agent_id: "a", capability_rank: 5, node_tier: "challenger", is_dead_locked: false } as const;

describe("checkBalance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns available balance", async () => {
    mockClient.getBalance.mockResolvedValue({ available: "42.5", challenge_locked: "10", staked: "5" });
    const result = await checkBalance(mockClient as any);
    expect(result).toBe(42.5);
  });

  it("returns 0 on error", async () => {
    mockClient.getBalance.mockRejectedValue(new Error("net error"));
    const result = await checkBalance(mockClient as any);
    expect(result).toBe(0);
  });
});

describe("fetchCapability", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns capability info on success", async () => {
    mockClient.getCapability.mockResolvedValue(CAPABLE);
    const cap = await fetchCapability(mockClient as any);
    expect(cap?.node_tier).toBe("capable");
  });

  it("propagates errors", async () => {
    mockClient.getCapability.mockRejectedValue(new Error("boom"));
    await expect(fetchCapability(mockClient as any)).rejects.toThrow("boom");
  });
});

describe("getTaskStats", () => {
  it("returns stats object", () => {
    const stats = getTaskStats();
    expect(stats).toHaveProperty("answering");
    expect(stats).toHaveProperty("judging");
  });
});

describe("processChallenges", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 when LLM is busy", async () => {
    vi.mocked(isLlmBusy).mockReturnValue(true);
    const count = await processChallenges(mockClient as any);
    expect(count).toBe(0);
  });

  it("returns 0 when no challenges", async () => {
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });
    const count = await processChallenges(mockClient as any);
    expect(count).toBe(0);
  });

  it("filters voted and in-flight challenges", async () => {
    vi.mocked(isLlmBusy).mockReturnValue(false);
    vi.mocked(secondsUntilDeadline).mockReturnValue(600);
    mockClient.getPendingChallenges.mockResolvedValue({
      challenges: [
        { id: "c1", has_voted: true },
        { id: "c2", has_voted: false, effective_voting_deadline: "2099-01-01T00:00:00Z" },
      ],
    });
    const count = await processChallenges(mockClient as any);
    expect(count).toBe(1);
  });

  it("skips challenges with low remaining time", async () => {
    vi.mocked(isLlmBusy).mockReturnValue(false);
    vi.mocked(secondsUntilDeadline).mockReturnValue(100);
    mockClient.getPendingChallenges.mockResolvedValue({
      challenges: [
        { id: "c-low", has_voted: false, effective_voting_deadline: "2099-01-01T00:00:00Z" },
      ],
    });
    const count = await processChallenges(mockClient as any);
    expect(count).toBe(0);
  });
});

describe("processQueries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 when no queries", async () => {
    mockClient.getActiveQueries.mockResolvedValue({ queries: [] });
    const count = await processQueries(mockClient as any);
    expect(count).toBe(0);
  });

  it("filters expired queries", async () => {
    mockClient.getActiveQueries.mockResolvedValue({
      queries: [
        {
          id: "q-exp",
          created_at: new Date(Date.now() - 3600_000).toISOString(),
          decision_deadline_at: new Date(Date.now() - 1800_000).toISOString(),
        },
      ],
    });
    const count = await processQueries(mockClient as any);
    expect(count).toBe(0);
  });

  it("processes eligible queries", async () => {
    mockClient.getActiveQueries.mockResolvedValue({
      queries: [
        {
          id: "q-elig",
          created_at: new Date(Date.now() - 60_000).toISOString(),
          decision_deadline_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
    });
    const count = await processQueries(mockClient as any);
    expect(count).toBe(1);
  });
});

describe("runCycle", () => {
  const challengeCtx = { client: {} as any, inFlight: new Set<string>() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCfg.node_role = "JUDGE";
  });

  it("processes challenges for Capable JUDGE", async () => {
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });
    const count = await runCycle(mockClient as any, CAPABLE, challengeCtx);
    expect(count).toBe(0);
    expect(mockClient.getPendingChallenges).toHaveBeenCalled();
  });

  it("processes queries for Capable ANSWERER", async () => {
    mockCfg.node_role = "ANSWERER";
    mockClient.getActiveQueries.mockResolvedValue({ queries: [] });
    const count = await runCycle(mockClient as any, CAPABLE, challengeCtx);
    expect(count).toBe(0);
    expect(mockClient.getActiveQueries).toHaveBeenCalled();
  });

  it("routes Challenger to capability-challenge worker unconditionally", async () => {
    vi.mocked(processChallengeRounds).mockResolvedValue(3);
    const count = await runCycle(mockClient as any, CHALLENGER, challengeCtx);
    expect(count).toBe(3);
    expect(processChallengeRounds).toHaveBeenCalledWith(challengeCtx);
    expect(mockClient.getPendingChallenges).not.toHaveBeenCalled();
    expect(mockClient.getActiveQueries).not.toHaveBeenCalled();
  });

  it("skips all work when dead-locked", async () => {
    const deadLocked = { ...CHALLENGER, is_dead_locked: true };
    const count = await runCycle(mockClient as any, deadLocked, challengeCtx);
    expect(count).toBe(0);
    expect(processChallengeRounds).not.toHaveBeenCalled();
    expect(mockClient.getPendingChallenges).not.toHaveBeenCalled();
  });

  it("logs warning for unknown role", async () => {
    mockCfg.node_role = "UNKNOWN";
    const count = await runCycle(mockClient as any, CAPABLE, challengeCtx);
    expect(count).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Unknown NODE_ROLE"));
  });
});

describe("main", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCfg.node_role = "JUDGE";
    mockCfg.inference_type = "openrouter";
    mockCfg.openrouter_api_key = "test-key";
    vi.mocked(loadIdentity).mockReturnValue({ node_id: "agent-1", node_secret: "sec" });
    mockClient.getCapability.mockResolvedValue(CAPABLE);
  });

  it("runs one cycle then stops on abort", async () => {
    mockClient.login.mockResolvedValue({});
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });
    vi.mocked(isLlmBusy).mockReturnValue(false);

    const ac = new AbortController();
    mockClient.getBalance.mockImplementation(async () => {
      ac.abort();
      return { available: "100.0" };
    });

    await main(ac.signal);
    expect(mockClient.login).toHaveBeenCalled();
  });

  it("exits when no identity", async () => {
    vi.mocked(loadIdentity).mockReturnValue(null);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits when no API key for openrouter", async () => {
    mockCfg.openrouter_api_key = "";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    await expect(main()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    mockCfg.openrouter_api_key = "test-key";
  });

  it("exits on invalid node_role", async () => {
    mockCfg.node_role = "BAD_ROLE";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    await expect(main()).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    mockCfg.node_role = "JUDGE";
  });

  it("pauses worker after LlmFailureError and probes with ping before resuming", async () => {
    mockClient.login.mockResolvedValue({});
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockClient.getCapability.mockResolvedValue(CHALLENGER);

    // Cycle 1: runCycle throws LlmFailureError → inferenceDown = true.
    // Cycle 2: ping returns false → skip work, inferenceDown stays true.
    // Cycle 3: ping returns true → work resumes, we abort from inside runCycle.
    const { LlmFailureError } = await import("../src/capability-challenge.js");
    const { processChallengeRounds } = await import("../src/capability-challenge.js");

    let cycleCount = 0;
    const ac = new AbortController();
    vi.mocked(processChallengeRounds).mockImplementation(async () => {
      cycleCount++;
      if (cycleCount === 1) throw new LlmFailureError(new Error("connection refused"));
      if (cycleCount === 2) {
        ac.abort();
        return 0;
      }
      return 0;
    });
    vi.mocked(pingLlm)
      .mockResolvedValueOnce(false)   // cycle 2 probe — still down
      .mockResolvedValueOnce(true);   // cycle 3 probe — restored

    mockClient.getBalance.mockResolvedValue({ available: "0", challenge_locked: "250" });

    await main(ac.signal);

    // processChallengeRounds called in cycles 1 and 3 (cycle 2 was skipped).
    expect(processChallengeRounds).toHaveBeenCalledTimes(2);
    expect(pingLlm).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Inference unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("still unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Inference restored"));
  });

  it("goes idle (warning log, no reset) when Capable has balance < min_balance", async () => {
    mockClient.login.mockResolvedValue({});
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockClient.getCapability.mockResolvedValue(CAPABLE);

    let callCount = 0;
    const ac = new AbortController();
    mockClient.getBalance.mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) ac.abort();
      return { available: "1.0" };
    });
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });

    await main(ac.signal);
    expect(mockClient.getPendingChallenges).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Low balance"));
  });

  it("does NOT gate Challenger on min_balance — runs Capability Challenge even with 0 available", async () => {
    mockClient.login.mockResolvedValue({});
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockClient.getCapability.mockResolvedValue(CHALLENGER);
    vi.mocked(processChallengeRounds).mockResolvedValue(0);

    let callCount = 0;
    const ac = new AbortController();
    mockClient.getBalance.mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) ac.abort();
      return { available: "0.0", challenge_locked: "250" };
    });

    await main(ac.signal);
    expect(processChallengeRounds).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Low balance"));
  });

  it("skips API key check for local inference", async () => {
    mockCfg.inference_type = "self-hosted";
    mockCfg.openrouter_api_key = "";
    mockClient.login.mockResolvedValue({});
    vi.mocked(isLlmBusy).mockReturnValue(false);

    const ac = new AbortController();
    mockClient.getBalance.mockImplementation(async () => {
      ac.abort();
      return { available: "100.0" };
    });
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });

    await main(ac.signal);
    expect(mockClient.login).toHaveBeenCalled();
    mockCfg.inference_type = "openrouter";
    mockCfg.openrouter_api_key = "test-key";
  });
});
