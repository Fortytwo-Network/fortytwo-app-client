import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = {
  agent_name: "testbot",
  display_name: "TestBot",
  inference_type: "openrouter" as const,
  openrouter_api_key: "sk-or-v1-abcdef1234567890",
  llm_api_base: "",
  fortytwo_api_base: "https://app.fortytwo.network/api",
  identity_file: "/tmp/identity.json",
  poll_interval: 120,
  llm_model: "z-ai/glm-4.7-flash",
  llm_concurrency: 40,
  llm_timeout: 120,
  min_balance: 5.0,
  bot_role: "JUDGE",
  answerer_system_prompt: "You are a helpful assistant.",
};

let savedConfig: any = null;

vi.mock("../src/config.js", () => ({
  get: () => ({ ...mockConfig }),
  saveConfig: (cfg: any) => { savedConfig = cfg; },
  reloadConfig: () => {},
}));

vi.mock("../src/identity.js", () => ({
  loadIdentity: (path: string) => ({
    agent_id: "test-agent-id",
    secret: "test-secret-key",
  }),
}));

vi.mock("../src/utils.js", () => ({
  setVerbose: vi.fn(),
}));

vi.mock("../src/llm.js", () => ({
  resetLlmClient: vi.fn(),
}));

import { executeCommand } from "../src/commands.js";
import { setVerbose } from "../src/utils.js";
import { resetLlmClient } from "../src/llm.js";

beforeEach(() => {
  savedConfig = null;
  vi.clearAllMocks();
});

describe("executeCommand", () => {
  it("returns empty for empty input", () => {
    expect(executeCommand("")).toEqual([]);
    expect(executeCommand("   ")).toEqual([]);
  });

  it("/help lists commands", () => {
    const result = executeCommand("/help");
    expect(result[0]).toBe("Commands:");
    expect(result.length).toBeGreaterThan(1);
  });

  it("works without / prefix too", () => {
    const result = executeCommand("help");
    expect(result[0]).toBe("Commands:");
  });

  it("/identity shows agent_id and secret", () => {
    const result = executeCommand("/identity");
    expect(result).toEqual([
      "Identity:",
      "  agent_id: test-agent-id",
      "  secret:   test-secret-key",
    ]);
  });

  it("/config show lists all keys with masked API key", () => {
    const result = executeCommand("/config show");
    expect(result[0]).toBe("Config:");
    const apiLine = result.find((l) => l.includes("openrouter_api_key"));
    expect(apiLine).toBeDefined();
    expect(apiLine).not.toContain("sk-or-v1-abcdef1234567890");
    expect(apiLine).toContain("***");
  });

  it("/config set saves and reloads", () => {
    const result = executeCommand("/config set llm_model gpt-4");
    expect(savedConfig).not.toBeNull();
    expect(savedConfig.llm_model).toBe("gpt-4");
    expect(result[0]).toContain("llm_model");
  });

  it("/config set LLM key resets client", () => {
    executeCommand("/config set llm_model test");
    expect(resetLlmClient).toHaveBeenCalled();
  });

  it("/config set non-LLM key does not reset client", () => {
    executeCommand("/config set bot_role ANSWERER");
    expect(resetLlmClient).not.toHaveBeenCalled();
  });

  it("/config set coerces numeric keys", () => {
    executeCommand("/config set poll_interval 60");
    expect(savedConfig.poll_interval).toBe(60);
    expect(typeof savedConfig.poll_interval).toBe("number");
  });

  it("/config set rejects invalid number", () => {
    const result = executeCommand("/config set poll_interval abc");
    expect(result[0]).toContain("Invalid number");
    expect(savedConfig).toBeNull();
  });

  it("/config set rejects unknown key", () => {
    const result = executeCommand("/config set nonexistent value");
    expect(result[0]).toContain("Unknown key");
  });

  it("/verbose on/off calls setVerbose", () => {
    executeCommand("/verbose on");
    expect(setVerbose).toHaveBeenCalledWith(true);
    executeCommand("/verbose off");
    expect(setVerbose).toHaveBeenCalledWith(false);
  });

  it("unknown command returns error", () => {
    const result = executeCommand("/foobar");
    expect(result[0]).toContain("Unknown command");
  });
});
