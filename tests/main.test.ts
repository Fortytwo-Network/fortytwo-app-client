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

import { parseArgs, InsufficientFundsError } from "../src/main.js";

describe("parseArgs", () => {
  it("parses --identity flag", () => {
    const args = parseArgs(["--identity", "my-id.json"]);
    expect(args.identity).toBe("my-id.json");
  });

  it("parses --register flag", () => {
    const args = parseArgs(["--register"]);
    expect(args.register).toBe(true);
  });

  it("parses --display-name flag", () => {
    const args = parseArgs(["--display-name", "TestBot"]);
    expect(args.displayName).toBe("TestBot");
  });

  it("parses --once flag", () => {
    const args = parseArgs(["--once"]);
    expect(args.once).toBe(true);
  });

  it("parses -v verbose flag", () => {
    const args = parseArgs(["-v"]);
    expect(args.verbose).toBe(true);
  });

  it("parses --verbose flag", () => {
    const args = parseArgs(["--verbose"]);
    expect(args.verbose).toBe(true);
  });

  it("parses multiple flags together", () => {
    const args = parseArgs(["--identity", "id.json", "--once", "-v", "--display-name", "Bot"]);
    expect(args.identity).toBe("id.json");
    expect(args.once).toBe(true);
    expect(args.verbose).toBe(true);
    expect(args.displayName).toBe("Bot");
  });

  it("returns empty object for no args", () => {
    const args = parseArgs([]);
    expect(args.identity).toBeUndefined();
    expect(args.register).toBeUndefined();
    expect(args.once).toBeUndefined();
    expect(args.verbose).toBeUndefined();
  });
});

describe("InsufficientFundsError", () => {
  it("is an Error with correct name", () => {
    const err = new InsufficientFundsError("low balance");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InsufficientFundsError");
    expect(err.message).toBe("low balance");
  });
});
