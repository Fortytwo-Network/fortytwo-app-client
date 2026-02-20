import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    inference_type: "openrouter",
    openrouter_api_key: "test-key",
    fortytwo_api_base: "https://api.test.com",
    identity_file: "identity.json",
    poll_interval: 60,
    llm_model: "test-model",
    llm_concurrency: 5,
    llm_timeout: 10,
    min_balance: 5.0,
    bot_role: "JUDGE",
    answerer_system_prompt: "You are a helpful assistant.",
  }),
  MIN_DEADLINE_SECONDS: 300,
}));

import { InsufficientFundsError } from "../src/main.js";

describe("InsufficientFundsError", () => {
  it("is an Error with correct name", () => {
    const err = new InsufficientFundsError("low balance");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InsufficientFundsError");
    expect(err.message).toBe("low balance");
  });
});
