import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    inference_type: "openrouter",
    openrouter_api_key: "test-key",
    fortytwo_api_base: "https://api.test.com",
    identity_file: "/tmp/identity.json",
    poll_interval: 60,
    llm_model: "test-model",
    llm_concurrency: 5,
    llm_timeout: 10,
    min_balance: 5.0,
    bot_role: "JUDGE",
    answerer_system_prompt: "You are a helpful assistant.",
  }),
  CONFIG_DIR: "/tmp/.fortytwo",
  configExists: vi.fn().mockReturnValue(true),
  saveConfig: vi.fn(),
  reloadConfig: vi.fn(),
  setConfigDir: vi.fn(),
  getConfigDir: vi.fn().mockReturnValue("/tmp/.fortytwo"),
}));

const mockClient = {
  agentId: "agent-1",
  login: vi.fn().mockResolvedValue({}),
  getAgent: vi.fn().mockResolvedValue({ profile: { display_name: "Bot" } }),
  createQuery: vi.fn().mockResolvedValue({ id: "q-1" }),
};

vi.mock("../src/api-client.js", () => {
  class MockFortyTwoClient {
    agentId = mockClient.agentId;
    login = mockClient.login;
    getAgent = mockClient.getAgent;
    createQuery = mockClient.createQuery;
  }
  return { FortyTwoClient: MockFortyTwoClient };
});

vi.mock("../src/identity.js", () => ({
  loadIdentity: vi.fn().mockReturnValue({ agent_id: "agent-1", secret: "sec" }),
  saveIdentity: vi.fn(),
  registerAgent: vi.fn().mockResolvedValue({ agent_id: "new-agent", secret: "new-sec" }),
}));

vi.mock("../src/main.js", () => ({
  main: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/commands.js", () => ({
  executeCommand: vi.fn().mockReturnValue(["Config:", "  bot_role: JUDGE"]),
}));

vi.mock("../src/setup-logic.js", () => ({
  validateModel: vi.fn().mockResolvedValue({ ok: true }),
  buildConfig: vi.fn().mockReturnValue({
    agent_name: "Bot",
    display_name: "Bot",
    inference_type: "openrouter",
    openrouter_api_key: "key",
    llm_api_base: "",
    fortytwo_api_base: "https://app.fortytwo.network/api",
    identity_file: "/tmp/identity.json",
    poll_interval: 120,
    llm_model: "test",
    llm_concurrency: 40,
    llm_timeout: 120,
    min_balance: 5.0,
    bot_role: "JUDGE",
    answerer_system_prompt: "You are a helpful assistant.",
  }),
}));

vi.mock("../src/utils.js", () => ({
  setVerbose: vi.fn(),
  log: vi.fn(),
}));

vi.mock("../src/profiles.js", () => ({
  initProfiles: vi.fn(),
  setProfileOverride: vi.fn(),
  listProfiles: vi.fn().mockReturnValue([]),
  switchProfile: vi.fn(),
  deleteProfile: vi.fn(),
  createProfile: vi.fn(),
  sanitizeProfileName: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, "-")),
  getProfileDir: vi.fn().mockReturnValue("/tmp/.fortytwo/profiles/default"),
  profileExists: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/index.js", () => ({}));

const origArgv = process.argv;

async function runCli(args: string[]) {
  process.argv = ["node", "cli.ts", ...args];
  vi.resetModules();
  await import("../src/cli.js");
}

describe("cli", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset mock implementations that tests may override
    const { configExists } = await import("../src/config.js");
    const { loadIdentity } = await import("../src/identity.js");
    const { validateModel } = await import("../src/setup-logic.js");
    vi.mocked(configExists).mockReturnValue(true);
    vi.mocked(loadIdentity).mockReturnValue({ agent_id: "agent-1", secret: "sec" });
    vi.mocked(validateModel).mockResolvedValue({ ok: true });
    mockClient.login.mockResolvedValue({});
    mockClient.getAgent.mockResolvedValue({ profile: { display_name: "Bot" } });
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    process.argv = origArgv;
  });

  describe("help", () => {
    it("prints usage info", async () => {
      await runCli(["help"]);
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("fortytwo");
      expect(output).toContain("setup");
      expect(output).toContain("import");
      expect(output).toContain("run");
      expect(output).toContain("ask");
    });
  });

  describe("identity", () => {
    it("calls executeCommand /identity", async () => {
      const { executeCommand } = await import("../src/commands.js");
      await runCli(["identity"]);
      expect(executeCommand).toHaveBeenCalledWith("/identity");
    });
  });

  describe("config", () => {
    it("config show calls executeCommand", async () => {
      const { executeCommand } = await import("../src/commands.js");
      await runCli(["config", "show"]);
      expect(executeCommand).toHaveBeenCalledWith("/config show");
    });

    it("config set calls executeCommand", async () => {
      const { executeCommand } = await import("../src/commands.js");
      await runCli(["config", "set", "bot_role", "ANSWERER"]);
      expect(executeCommand).toHaveBeenCalledWith("/config set bot_role ANSWERER");
    });

    it("config set without key/value exits", async () => {
      await runCli(["config", "set"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("config without subcommand exits", async () => {
      await runCli(["config"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("setup", () => {
    const setupFlags = [
      "--name", "TestBot",
      "--inference-type", "openrouter",
      "--api-key", "sk-or-xxx",
      "--model", "test-model",
      "--role", "JUDGE",
      "--skip-validation",
    ];

    it("completes full setup flow", async () => {
      const { createProfile } = await import("../src/profiles.js");
      const { registerAgent } = await import("../src/identity.js");
      await runCli(["setup", ...setupFlags]);
      expect(createProfile).toHaveBeenCalled();
      expect(registerAgent).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Setup complete");
    });

    it("validates model when no --skip-validation", async () => {
      const { validateModel } = await import("../src/setup-logic.js");
      await runCli(["setup", "--name", "B", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "JUDGE"]);
      expect(validateModel).toHaveBeenCalled();
    });

    it("exits on validation failure", async () => {
      const { validateModel } = await import("../src/setup-logic.js");
      vi.mocked(validateModel).mockResolvedValue({ ok: false, error: "not found" });
      await runCli(["setup", "--name", "B", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on missing --name flag", async () => {
      await runCli(["setup", "--inference-type", "openrouter", "--model", "m", "--role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on invalid inference type", async () => {
      await runCli(["setup", "--name", "B", "--inference-type", "invalid", "--model", "m", "--role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on invalid role", async () => {
      await runCli(["setup", "--name", "B", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "INVALID"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("requires llm-api-base for local inference", async () => {
      await runCli(["setup", "--name", "B", "--inference-type", "local", "--model", "m", "--role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("works with local inference", async () => {
      await runCli(["setup", "--name", "B", "--inference-type", "local", "--llm-api-base", "http://localhost:11434/v1", "--model", "m", "--role", "JUDGE", "--skip-validation"]);
      const { createProfile } = await import("../src/profiles.js");
      expect(createProfile).toHaveBeenCalled();
    });
  });

  describe("import", () => {
    const importFlags = [
      "--agent-id", "uuid-123",
      "--secret", "sec-456",
      "--inference-type", "openrouter",
      "--api-key", "sk-or-xxx",
      "--model", "test-model",
      "--role", "JUDGE",
      "--skip-validation",
    ];

    it("completes full import flow", async () => {
      const { createProfile } = await import("../src/profiles.js");
      await runCli(["import", ...importFlags]);
      expect(createProfile).toHaveBeenCalled();
      expect(mockClient.login).toHaveBeenCalledWith("uuid-123", "sec-456");
    });

    it("exits on login failure", async () => {
      mockClient.login.mockRejectedValueOnce(new Error("invalid creds"));
      await runCli(["import", ...importFlags]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on invalid inference type", async () => {
      await runCli(["import", "--agent-id", "a", "--secret", "s", "--inference-type", "bad", "--model", "m", "--role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on invalid role", async () => {
      await runCli(["import", "--agent-id", "a", "--secret", "s", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "BAD"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("validates model when no --skip-validation", async () => {
      const { validateModel } = await import("../src/setup-logic.js");
      await runCli(["import", "--agent-id", "a", "--secret", "s", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "JUDGE"]);
      expect(validateModel).toHaveBeenCalled();
    });

    it("handles getAgent failure gracefully", async () => {
      mockClient.getAgent.mockRejectedValueOnce(new Error("not found"));
      await runCli(["import", ...importFlags]);
      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("uuid-123");
    });

    it("exits on import validation failure", async () => {
      const { validateModel } = await import("../src/setup-logic.js");
      vi.mocked(validateModel).mockResolvedValue({ ok: false, error: "bad model" });
      await runCli(["import", "--agent-id", "a", "--secret", "s", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("works with local inference", async () => {
      await runCli(["import", "--agent-id", "a", "--secret", "s", "--inference-type", "local", "--llm-api-base", "http://localhost:11434/v1", "--model", "m", "--role", "JUDGE", "--skip-validation"]);
      const { createProfile } = await import("../src/profiles.js");
      expect(createProfile).toHaveBeenCalled();
    });
  });

  describe("run", () => {
    it("starts main loop", async () => {
      const { main: mainFn } = await import("../src/main.js");
      await runCli(["run"]);
      expect(mainFn).toHaveBeenCalled();
    });

    it("exits when no config", async () => {
      const { configExists } = await import("../src/config.js");
      vi.mocked(configExists).mockReturnValue(false);
      await runCli(["run"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when no identity", async () => {
      const { loadIdentity } = await import("../src/identity.js");
      vi.mocked(loadIdentity).mockReturnValue(null);
      await runCli(["run"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("ask", () => {
    it("submits a question", async () => {
      await runCli(["ask", "What", "is", "2+2?"]);
      expect(mockClient.login).toHaveBeenCalled();
      expect(mockClient.createQuery).toHaveBeenCalled();
    });

    it("exits when no question", async () => {
      await runCli(["ask"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when no config", async () => {
      const { configExists } = await import("../src/config.js");
      vi.mocked(configExists).mockReturnValue(false);
      await runCli(["ask", "test"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when no identity", async () => {
      const { loadIdentity } = await import("../src/identity.js");
      vi.mocked(loadIdentity).mockReturnValue(null);
      await runCli(["ask", "test"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("unknown command", () => {
    it("exits with error for unknown command", async () => {
      await runCli(["banana"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      const output = errorSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Unknown command");
    });
  });

  describe("verbose flag", () => {
    it("-v sets verbose", async () => {
      const { setVerbose } = await import("../src/utils.js");
      await runCli(["-v", "help"]);
      expect(setVerbose).toHaveBeenCalledWith(true);
    });

    it("--verbose sets verbose", async () => {
      const { setVerbose } = await import("../src/utils.js");
      await runCli(["--verbose", "help"]);
      expect(setVerbose).toHaveBeenCalledWith(true);
    });
  });

  describe("no subcommand", () => {
    it("imports index.js for interactive UI", async () => {
      await runCli([]);
      // If no subcommand, it dynamically imports ./index.js — mocked above
      // The test passes if no error thrown
    });
  });
});
