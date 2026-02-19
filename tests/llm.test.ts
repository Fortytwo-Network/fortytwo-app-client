import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config before importing llm
vi.mock("../src/config.js", () => ({
  get: () => ({
    inference_type: "openrouter",
    openrouter_api_key: "test-key",
    llm_model: "test-model",
    llm_concurrency: 5,
    llm_timeout: 10,
  }),
}));

import { callLlm, compareForRegistration, evaluateGoodEnough, comparePairwise, generateAnswer } from "../src/llm.js";

describe("llm", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockLlmResponse(content: string, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
      text: async () => content,
      headers: new Headers(),
    } as any);
  }

  describe("callLlm", () => {
    it("sends prompt and returns response content", async () => {
      mockLlmResponse("Hello World");
      const result = await callLlm("Say hello");
      expect(result).toBe("Hello World");

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.model).toBe("test-model");
      expect(body.messages[0].content).toBe("Say hello");
    });
  });

  describe("compareForRegistration", () => {
    it("returns 1 when LLM says A", async () => {
      mockLlmResponse("After analysis, solution A is better.\nA");
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(1);
    });

    it("returns -1 when LLM says B", async () => {
      mockLlmResponse("B is clearly better\nB");
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(-1);
    });

    it("returns 0 when LLM says U", async () => {
      mockLlmResponse("Cannot determine\nU");
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(0);
    });

    it("returns 0 on LLM failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(0);
    });
  });

  describe("evaluateGoodEnough", () => {
    it("returns true for GOOD response", async () => {
      mockLlmResponse("This is a genuine attempt.\nGOOD");
      const result = await evaluateGoodEnough("problem", "solution");
      expect(result).toBe(true);
    });

    it("returns false for BAD response", async () => {
      mockLlmResponse("This is spam.\nBAD");
      const result = await evaluateGoodEnough("problem", "solution");
      expect(result).toBe(false);
    });

    it("defaults to true when ambiguous", async () => {
      mockLlmResponse("It seems okay overall.");
      const result = await evaluateGoodEnough("problem", "solution");
      expect(result).toBe(true);
    });
  });

  describe("comparePairwise", () => {
    it("returns A when LLM picks A", async () => {
      mockLlmResponse("A is better\nA");
      const result = await comparePairwise("p", "a", "b");
      expect(result).toBe("A");
    });

    it("returns B when LLM picks B", async () => {
      mockLlmResponse("B wins\nB");
      const result = await comparePairwise("p", "a", "b");
      expect(result).toBe("B");
    });

    it("returns null on LLM failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));
      const result = await comparePairwise("p", "a", "b");
      expect(result).toBeNull();
    });
  });

  describe("generateAnswer", () => {
    it("sends system + user messages", async () => {
      mockLlmResponse("The answer is 42");
      const result = await generateAnswer("Be helpful", "What is 6*7?");
      expect(result).toBe("The answer is 42");

      const call = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.messages[0]).toEqual({ role: "system", content: "Be helpful" });
      expect(body.messages[1]).toEqual({ role: "user", content: "What is 6*7?" });
      expect(body.temperature).toBe(0.7);
    });
  });
});
