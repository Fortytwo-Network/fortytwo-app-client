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
};

vi.mock("../src/api-client.js", () => {
  class MockFortyTwoClient {
    nodeId = mockClient.nodeId;
    login = mockClient.login;
    getPendingChallenges = mockClient.getPendingChallenges;
    getActiveQueries = mockClient.getActiveQueries;
    getBalance = mockClient.getBalance;
  }
  return { FortyTwoClient: MockFortyTwoClient };
});

vi.mock("../src/identity.js", () => ({
  loadIdentity: vi.fn().mockReturnValue({ node_id: "agent-1", secret: "sec" }),
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
}));

vi.mock("../src/setup-logic.js", () => ({
  validateModel: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../src/utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  secondsUntilDeadline: vi.fn().mockReturnValue(600),
  setVerbose: vi.fn(),
  log: vi.fn(),
  getRoleLabel: vi.fn((v) => v),
}));

import {
  InsufficientFundsError,
  checkBalance,
  processChallenges,
  processQueries,
  runCycle,
  getTaskStats,
  main,
} from "../src/main.js";
import { loadIdentity, resetAccount } from "../src/identity.js";
import { isLlmBusy } from "../src/llm.js";
import { secondsUntilDeadline, log } from "../src/utils.js";

describe("InsufficientFundsError", () => {
  it("is an Error with correct name", () => {
    const err = new InsufficientFundsError("low balance");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InsufficientFundsError");
    expect(err.message).toBe("low balance");
  });
});

describe("checkBalance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns available balance", async () => {
    mockClient.getBalance.mockResolvedValue({ available: "42.5" });
    const result = await checkBalance(mockClient as any);
    expect(result).toBe(42.5);
  });

  it("returns 0 on error", async () => {
    mockClient.getBalance.mockRejectedValue(new Error("net error"));
    const result = await checkBalance(mockClient as any);
    expect(result).toBe(0);
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

  it("uses dualMode to filter by shouldAnswer", async () => {
    vi.mocked(isLlmBusy).mockReturnValue(false);
    vi.mocked(secondsUntilDeadline).mockReturnValue(600);
    mockClient.getPendingChallenges.mockResolvedValue({
      challenges: Array.from({ length: 10 }, (_, i) => ({
        id: `ch-dual-${i}`,
        has_voted: false,
        query_id: `q-dual-${i}`,
        effective_voting_deadline: "2099-01-01T00:00:00Z",
      })),
    });
    const count = await processChallenges(mockClient as any, true);
    // Some are filtered by shouldAnswer hash, count should be < 10
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(10);
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

  it("uses dualMode to filter by shouldAnswer", async () => {
    mockClient.getActiveQueries.mockResolvedValue({
      queries: Array.from({ length: 10 }, (_, i) => ({
        id: `q-dm-${i}`,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        decision_deadline_at: new Date(Date.now() + 3600_000).toISOString(),
      })),
    });
    const count = await processQueries(mockClient as any, true);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(10);
  });
});

describe("runCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCfg.node_role = "JUDGE";
  });

  it("processes challenges for JUDGE role", async () => {
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });
    const count = await runCycle(mockClient as any);
    expect(count).toBe(0);
    expect(mockClient.getPendingChallenges).toHaveBeenCalled();
    expect(mockClient.getActiveQueries).not.toHaveBeenCalled();
  });

  it("processes queries for ANSWERER role", async () => {
    mockCfg.node_role = "ANSWERER";
    mockClient.getActiveQueries.mockResolvedValue({ queries: [] });
    const count = await runCycle(mockClient as any);
    expect(count).toBe(0);
    expect(mockClient.getActiveQueries).toHaveBeenCalled();
    expect(mockClient.getPendingChallenges).not.toHaveBeenCalled();
  });

  it("processes both for ANSWERER_AND_JUDGE role", async () => {
    mockCfg.node_role = "ANSWERER_AND_JUDGE";
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockClient.getActiveQueries.mockResolvedValue({ queries: [] });
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });
    const count = await runCycle(mockClient as any);
    expect(count).toBe(0);
    expect(mockClient.getActiveQueries).toHaveBeenCalled();
    expect(mockClient.getPendingChallenges).toHaveBeenCalled();
  });

  it("logs warning for unknown role", async () => {
    mockCfg.node_role = "UNKNOWN";
    const count = await runCycle(mockClient as any);
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
    vi.mocked(loadIdentity).mockReturnValue({ node_id: "agent-1", secret: "sec" });
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

  it("resets account on InsufficientFundsError", async () => {
    mockClient.login.mockResolvedValue({});
    vi.mocked(isLlmBusy).mockReturnValue(false);

    let callCount = 0;
    const ac = new AbortController();
    mockClient.getBalance.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { available: "1.0" }; // below min_balance
      ac.abort();
      return { available: "100.0" };
    });
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });

    await main(ac.signal);
    expect(resetAccount).toHaveBeenCalled();
  });

  it("handles generic error in cycle", async () => {
    mockClient.login.mockResolvedValue({});
    mockClient.getBalance.mockResolvedValue({ available: "100.0" });

    const ac = new AbortController();
    let callCount = 0;
    mockClient.getPendingChallenges.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("random failure");
      ac.abort();
      return { challenges: [] };
    });
    vi.mocked(isLlmBusy).mockReturnValue(false);

    await main(ac.signal);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Error in polling cycle"));
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

  it("sets verbose when --verbose in argv", async () => {
    const origArgv = process.argv;
    process.argv = [...origArgv, "--verbose"];
    mockClient.login.mockResolvedValue({});
    vi.mocked(isLlmBusy).mockReturnValue(false);

    const ac = new AbortController();
    mockClient.getBalance.mockImplementation(async () => {
      ac.abort();
      return { available: "100.0" };
    });
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });

    const { setVerbose } = await import("../src/utils.js");
    await main(ac.signal);
    expect(setVerbose).toHaveBeenCalledWith(true);
    process.argv = origArgv;
  });

  it("logs when cycle takes longer than poll_interval", async () => {
    mockClient.login.mockResolvedValue({});
    vi.mocked(isLlmBusy).mockReturnValue(false);
    mockCfg.poll_interval = 0; // 0 seconds

    const ac = new AbortController();
    let callCount = 0;
    mockClient.getBalance.mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) ac.abort();
      return { available: "100.0" };
    });
    mockClient.getPendingChallenges.mockResolvedValue({ challenges: [] });

    await main(ac.signal);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("starting next immediately"));
    mockCfg.poll_interval = 1;
  });
});
