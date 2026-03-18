import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, msg = "") {
      super(msg);
      this.status = status;
    }
  }
  class RateLimitError extends APIError { constructor(m = "") { super(429, m); } }
  class AuthenticationError extends APIError { constructor(m = "") { super(401, m); } }
  class PermissionDeniedError extends APIError { constructor(m = "") { super(403, m); } }
  class BadRequestError extends APIError { constructor(m = "") { super(400, m); } }
  class NotFoundError extends APIError { constructor(m = "") { super(404, m); } }
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends APIConnectionError {}

  return {
    default: class {
      chat = { completions: { create: mockCreate } };
      constructor() {}
    },
    APIError,
    RateLimitError,
    AuthenticationError,
    PermissionDeniedError,
    BadRequestError,
    NotFoundError,
    APIConnectionError,
    APIConnectionTimeoutError,
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

  describe("OpenRouter error messages", () => {
    let RateLimitError: any;
    let AuthenticationError: any;
    let PermissionDeniedError: any;
    let BadRequestError: any;
    let APIError: any;
    let APIConnectionTimeoutError: any;

    beforeEach(async () => {
      const mod = await import("openai");
      RateLimitError = (mod as any).RateLimitError;
      AuthenticationError = (mod as any).AuthenticationError;
      PermissionDeniedError = (mod as any).PermissionDeniedError;
      BadRequestError = (mod as any).BadRequestError;
      APIError = (mod as any).APIError;
      APIConnectionTimeoutError = (mod as any).APIConnectionTimeoutError;
      mockLlmCfg.inference_type = "openrouter";
      resetLlmClient();
    });

    it("rate limit (429) shows OpenRouter message", async () => {
      mockCreate.mockRejectedValue(new RateLimitError());
      await expect(callLlm("test")).rejects.toThrow("OpenRouter rate limit exceeded");
    });

    it("authentication (401) shows OpenRouter message", async () => {
      mockCreate.mockRejectedValue(new AuthenticationError());
      await expect(callLlm("test")).rejects.toThrow("OpenRouter authentication failed");
    });

    it("permission denied (403) shows moderation message", async () => {
      mockCreate.mockRejectedValue(new PermissionDeniedError());
      await expect(callLlm("test")).rejects.toThrow("OpenRouter rejected the request");
    });

    it("bad request (400) shows OpenRouter message", async () => {
      mockCreate.mockRejectedValue(new BadRequestError());
      await expect(callLlm("test")).rejects.toThrow("OpenRouter bad request");
    });

    it("payment required (402) shows credits message", async () => {
      mockCreate.mockRejectedValue(new APIError(402, "insufficient credits"));
      await expect(callLlm("test")).rejects.toThrow("OpenRouter credits exhausted");
    });

    it("bad gateway (502) shows unavailable message", async () => {
      mockCreate.mockRejectedValue(new APIError(502, "bad gateway"));
      await expect(callLlm("test")).rejects.toThrow("temporarily unavailable");
    });

    it("service unavailable (503) shows unavailable message", async () => {
      mockCreate.mockRejectedValue(new APIError(503, "no provider"));
      await expect(callLlm("test")).rejects.toThrow("temporarily unavailable");
    });

    it("timeout shows OpenRouter timeout message", async () => {
      mockCreate.mockRejectedValue(new APIConnectionTimeoutError());
      await expect(callLlm("test")).rejects.toThrow("OpenRouter request timed out");
    });
  });

  describe("local LLM error messages", () => {
    let APIConnectionError: any;
    let APIConnectionTimeoutError: any;
    let NotFoundError: any;

    beforeEach(async () => {
      const mod = await import("openai");
      APIConnectionError = (mod as any).APIConnectionError;
      APIConnectionTimeoutError = (mod as any).APIConnectionTimeoutError;
      NotFoundError = (mod as any).NotFoundError;
      mockLlmCfg.inference_type = "local";
      mockLlmCfg.llm_api_base = "http://localhost:11434/v1";
      resetLlmClient();
    });

    afterEach(() => {
      mockLlmCfg.inference_type = "openrouter";
      delete mockLlmCfg.llm_api_base;
      resetLlmClient();
    });

    it("timeout shows local LLM message", async () => {
      mockCreate.mockRejectedValue(new APIConnectionTimeoutError());
      await expect(callLlm("test")).rejects.toThrow("Local LLM at http://localhost:11434/v1 timed out");
    });

    it("connection error shows local LLM message", async () => {
      mockCreate.mockRejectedValue(new APIConnectionError());
      await expect(callLlm("test")).rejects.toThrow("Cannot connect to local LLM");
    });

    it("not found shows model message", async () => {
      mockCreate.mockRejectedValue(new NotFoundError());
      await expect(callLlm("test")).rejects.toThrow('Model "test-model" not found');
    });
  });
});
