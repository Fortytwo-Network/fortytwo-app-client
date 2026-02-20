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
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(1);
    });

    it("returns -1 when LLM says B", async () => {
      mockResponse("B is clearly better\nB");
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(-1);
    });

    it("returns 0 when LLM says U", async () => {
      mockResponse("Cannot determine\nU");
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(0);
    });

    it("returns 0 on LLM failure", async () => {
      mockCreate.mockRejectedValue(new Error("network error"));
      const result = await compareForRegistration("q", "a", "b");
      expect(result).toBe(0);
    });
  });

  describe("evaluateGoodEnough", () => {
    it("returns true for GOOD response", async () => {
      mockResponse("This is a genuine attempt.\nGOOD");
      const result = await evaluateGoodEnough("problem", "solution");
      expect(result).toBe(true);
    });

    it("returns false for BAD response", async () => {
      mockResponse("This is spam.\nBAD");
      const result = await evaluateGoodEnough("problem", "solution");
      expect(result).toBe(false);
    });

    it("defaults to true when ambiguous", async () => {
      mockResponse("It seems okay overall.");
      const result = await evaluateGoodEnough("problem", "solution");
      expect(result).toBe(true);
    });
  });

  describe("comparePairwise", () => {
    it("returns A when LLM picks A", async () => {
      mockResponse("A is better\nA");
      const result = await comparePairwise("p", "a", "b");
      expect(result).toBe("A");
    });

    it("returns B when LLM picks B", async () => {
      mockResponse("B wins\nB");
      const result = await comparePairwise("p", "a", "b");
      expect(result).toBe("B");
    });

    it("returns null on LLM failure", async () => {
      mockCreate.mockRejectedValue(new Error("timeout"));
      const result = await comparePairwise("p", "a", "b");
      expect(result).toBeNull();
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
});
