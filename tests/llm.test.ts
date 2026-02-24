import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class {
      chat = { completions: { create: mockCreate } };
      constructor() {}
    },
  };
});

const mockLlmCfg: Record<string, any> = {
  inference_type: "openrouter",
  openrouter_api_key: "test-key",
  llm_model: "test-model",
  llm_concurrency: 2,
  llm_timeout: 10,
};

vi.mock("../src/config.js", () => ({
  get: () => mockLlmCfg,
}));

import {
  callLlm,
  compareForRegistration,
  evaluateGoodEnough,
  comparePairwise,
  generateAnswer,
  isLlmBusy,
  resetLlmClient,
  getLlmStats,
} from "../src/llm.js";

describe("llm", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  function mockResponse(content: string) {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content } }],
    });
  }

  describe("callLlm", () => {
    it("sends prompt and returns response content", async () => {
      mockResponse("Hello World");
      const result = await callLlm("Say hello");
      expect(result).toBe("Hello World");
      const call = mockCreate.mock.calls[0];
      expect(call[0].model).toBe("test-model");
      expect(call[0].messages[0].content).toBe("Say hello");
    });
  });

  describe("compareForRegistration", () => {
    it("returns 1 when LLM says A", async () => {
      mockResponse("After analysis, solution A is better.\nA");
      expect(await compareForRegistration("q", "a", "b")).toBe(1);
    });

    it("returns -1 when LLM says B", async () => {
      mockResponse("B is clearly better\nB");
      expect(await compareForRegistration("q", "a", "b")).toBe(-1);
    });

    it("returns 0 when LLM says U", async () => {
      mockResponse("Cannot determine\nU");
      expect(await compareForRegistration("q", "a", "b")).toBe(0);
    });

    it("returns 0 on LLM failure", async () => {
      mockCreate.mockRejectedValue(new Error("network error"));
      expect(await compareForRegistration("q", "a", "b")).toBe(0);
    });

    it("returns 0 after 2 unparseable attempts", async () => {
      mockResponse("I cannot decide clearly...");
      expect(await compareForRegistration("q", "a", "b")).toBe(0);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe("evaluateGoodEnough", () => {
    it("returns true for GOOD response", async () => {
      mockResponse("This is a genuine attempt.\nGOOD");
      expect(await evaluateGoodEnough("problem", "solution")).toBe(true);
    });

    it("returns false for BAD response", async () => {
      mockResponse("This is spam.\nBAD");
      expect(await evaluateGoodEnough("problem", "solution")).toBe(false);
    });

    it("defaults to true when ambiguous", async () => {
      mockResponse("It seems okay overall.");
      expect(await evaluateGoodEnough("problem", "solution")).toBe(true);
    });

    it("returns false on error", async () => {
      mockCreate.mockRejectedValue(new Error("fail"));
      expect(await evaluateGoodEnough("p", "s")).toBe(false);
    });
  });

  describe("comparePairwise", () => {
    it("returns A when LLM picks A", async () => {
      mockResponse("A is better\nA");
      expect(await comparePairwise("p", "a", "b")).toBe("A");
    });

    it("returns B when LLM picks B", async () => {
      mockResponse("B wins\nB");
      expect(await comparePairwise("p", "a", "b")).toBe("B");
    });

    it("returns null on LLM failure", async () => {
      mockCreate.mockRejectedValue(new Error("timeout"));
      expect(await comparePairwise("p", "a", "b")).toBeNull();
    });

    it("returns U after 2 unparseable attempts", async () => {
      mockResponse("I cannot decide...");
      expect(await comparePairwise("p", "a", "b")).toBe("U");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe("generateAnswer", () => {
    it("sends system + user messages", async () => {
      mockResponse("The answer is 42");
      const result = await generateAnswer("Be helpful", "What is 6*7?");
      expect(result).toBe("The answer is 42");
      const call = mockCreate.mock.calls[0];
      expect(call[0].messages[0]).toEqual({ role: "system", content: "Be helpful" });
      expect(call[0].messages[1]).toEqual({ role: "user", content: "What is 6*7?" });
      expect(call[0].temperature).toBe(0.7);
    });
  });

  describe("isLlmBusy", () => {
    it("returns false when no queue pressure", () => {
      expect(isLlmBusy()).toBe(false);
    });
  });

  describe("resetLlmClient", () => {
    it("resets without error", () => {
      expect(() => resetLlmClient()).not.toThrow();
    });
  });

  describe("getLlmStats", () => {
    it("returns stats object", () => {
      const stats = getLlmStats();
      expect(stats).toHaveProperty("active");
      expect(stats).toHaveProperty("queued");
      expect(stats).toHaveProperty("calls");
      expect(stats).toHaveProperty("errors");
      expect(stats).toHaveProperty("rankingAvgMs");
      expect(stats).toHaveProperty("generationAvgMs");
    });
  });

  describe("semaphore queuing", () => {
    it("queues when concurrency limit reached", async () => {
      // concurrency = 2 in config mock
      resetLlmClient();
      const resolvers: (() => void)[] = [];
      mockCreate.mockImplementation(() => new Promise((resolve) => {
        resolvers.push(() => resolve({ choices: [{ message: { content: "ok" } }] }));
      }));

      // Launch 3 calls (limit = 2, so 3rd queues)
      const p1 = callLlm("test1");
      const p2 = callLlm("test2");
      const p3 = callLlm("test3");

      // Wait a tick for promises to settle
      await new Promise((r) => setTimeout(r, 10));

      // First 2 should have acquired semaphore, 3rd is queued
      expect(resolvers).toHaveLength(2);

      // Resolve all
      resolvers.forEach((r) => r());
      await new Promise((r) => setTimeout(r, 10));
      if (resolvers.length > 2) resolvers[2]();
      // Resolve the 3rd that just started
      await new Promise((r) => setTimeout(r, 10));
      if (resolvers.length > 2) resolvers.slice(2).forEach((r) => r());

      const results = await Promise.all([p1, p2, p3]);
      expect(results).toHaveLength(3);
    });
  });

  describe("callLlm without API key", () => {
    it("throws when openrouter API key is not set", async () => {
      resetLlmClient();
      const origKey = mockLlmCfg.openrouter_api_key;
      mockLlmCfg.openrouter_api_key = "";
      await expect(callLlm("test")).rejects.toThrow("OPENROUTER_API_KEY is not set");
      mockLlmCfg.openrouter_api_key = origKey;
    });
  });
});
