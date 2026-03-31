import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = {
  node_name: "testbot",
  node_display_name: "TestBot",
  inference_type: "openrouter" as const,
  openrouter_api_key: "sk-or-v1-abcdef1234567890",
  self_hosted_api_base: "",
  fortytwo_api_base: "https://app.fortytwo.network/api",
  identity_file: "/tmp/identity.json",
  poll_interval: 120,
  model_name: "qwen/qwen3.5-35b-a3b",
  llm_concurrency: 40,
  llm_timeout: 120,
  min_balance: 5.0,
  node_role: "JUDGE",
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
    node_id: "test-agent-id",
    node_secret: "test-secret-key",
  }),
}));

vi.mock("../src/utils.js", () => ({
  setVerbose: vi.fn(),
}));

vi.mock("../src/llm.js", () => ({
  resetLlmClient: vi.fn(),
}));

vi.mock("../src/profiles.js", () => ({
  listProfiles: vi.fn().mockReturnValue([
    { name: "default", active: true, agentName: "testbot", nodeId: "test-agent-id" },
  ]),
  switchProfile: vi.fn(),
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

  it("/identity shows node_id and secret", () => {
    const result = executeCommand("/identity");
    expect(result).toEqual([
      "Identity:",
      "  node_id: test-agent-id",
      "  node_secret:   test-secret-key",
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
    const result = executeCommand("/config set model_name gpt-4");
    expect(savedConfig).not.toBeNull();
    expect(savedConfig.model_name).toBe("gpt-4");
    expect(result[0]).toContain("model_name");
  });

  it("/config set LLM key resets client", () => {
    executeCommand("/config set model_name test");
    expect(resetLlmClient).toHaveBeenCalled();
  });

  it("/config set non-LLM key does not reset client", () => {
    executeCommand("/config set node_role ANSWERER");
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

  it("/exit calls process.exit(0)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    executeCommand("/exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("/quit calls process.exit(0)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    executeCommand("/quit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("/config without subcommand returns usage", () => {
    const result = executeCommand("/config");
    expect(result[0]).toContain("Usage:");
  });

  describe("/profile", () => {
    it("/profile list shows profiles", async () => {
      const { listProfiles } = await import("../src/profiles.js");
      vi.mocked(listProfiles).mockReturnValue([
        { name: "my-judge", active: true, agentName: "MyJudge", nodeId: "aaaa-bbbb-cccc" },
        { name: "answerer", active: false, agentName: "Answerer", nodeId: "dddd-eeee-ffff" },
      ]);
      const result = executeCommand("/profile list");
      expect(result[0]).toBe("Profiles:");
      expect(result[1]).toContain("my-judge");
      expect(result[1]).toContain("(active)");
      expect(result[2]).toContain("answerer");
      expect(result[2]).not.toContain("(active)");
    });

    it("/profile without subcommand shows list", async () => {
      const { listProfiles } = await import("../src/profiles.js");
      vi.mocked(listProfiles).mockReturnValue([
        { name: "default", active: true, agentName: "Bot", nodeId: "id-1" },
      ]);
      const result = executeCommand("/profile");
      expect(result[0]).toBe("Profiles:");
      expect(result[1]).toContain("default");
    });

    it("/profile list returns message when no profiles", async () => {
      const { listProfiles } = await import("../src/profiles.js");
      vi.mocked(listProfiles).mockReturnValue([]);
      const result = executeCommand("/profile list");
      expect(result[0]).toContain("No profiles");
    });

    it("/profile switch changes profile and returns marker", async () => {
      const { switchProfile } = await import("../src/profiles.js");
      const result = executeCommand("/profile switch my-judge");
      expect(switchProfile).toHaveBeenCalledWith("my-judge");
      expect(resetLlmClient).toHaveBeenCalled();
      expect(result[0]).toContain("__SWITCH_PROFILE__:my-judge");
      expect(result[1]).toContain("Switched to profile");
    });

    it("/profile switch without name shows usage", async () => {
      const { listProfiles } = await import("../src/profiles.js");
      vi.mocked(listProfiles).mockReturnValue([
        { name: "default", active: true, agentName: "Bot", nodeId: "id-1" },
      ]);
      const result = executeCommand("/profile switch");
      expect(result[0]).toContain("Usage:");
      expect(result).toEqual(expect.arrayContaining([expect.stringContaining("Available profiles")]));
    });

    it("/profile switch returns error for unknown profile", async () => {
      const { switchProfile } = await import("../src/profiles.js");
      vi.mocked(switchProfile).mockImplementation(() => { throw new Error('Profile "nope" not found'); });
      const result = executeCommand("/profile switch nope");
      expect(result[0]).toContain("not found");
    });

    it("/profile create returns create marker", () => {
      const result = executeCommand("/profile create");
      expect(result[0]).toBe("__CREATE_PROFILE__");
      expect(result[1]).toContain("Starting profile creation");
    });

    it("/profile unknown subcommand shows profile help", () => {
      const result = executeCommand("/profile unknown");
      expect(result[0]).toContain("Profile commands:");
    });
  });
});
