import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    inference_type: "openrouter",
    openrouter_api_key: "test-key",
    fortytwo_api_base: "https://api.test.com",
    identity_file: "/tmp/identity.json",
    poll_interval: 60,
    model_name: "test-model",
    llm_concurrency: 5,
    llm_timeout: 10,
    min_balance: 5.0,
    node_role: "JUDGE",
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
  nodeId: "agent-1",
  login: vi.fn().mockResolvedValue({}),
  getAgent: vi.fn().mockResolvedValue({ profile: { node_display_name: "Bot" } }),
  createQuery: vi.fn().mockResolvedValue({ id: "q-1" }),
  getCapability: vi.fn().mockResolvedValue({
    agent_id: "agent-1",
    capability_rank: 42,
    node_tier: "capable",
    is_dead_locked: false,
  }),
  resetCapability: vi.fn().mockResolvedValue({
    agent_id: "agent-1",
    capability_rank: 0,
    rank_before: 30,
    challenge_locked: "250",
    drop_amount: "250",
  }),
  listActiveChallengeRounds: vi.fn().mockResolvedValue({
    items: [], total: 0, page: 1, page_size: 20,
  }),
  getChallengeRound: vi.fn().mockResolvedValue({ has_joined: false }),
  joinChallengeRound: vi.fn().mockResolvedValue({
    content: "Q?", stake_amount: "10", participant_id: "p-1",
  }),
  submitChallengeAnswer: vi.fn().mockResolvedValue({
    id: "ans-1", staked_amount: "10",
  }),
  getCapabilityHistory: vi.fn().mockResolvedValue({
    items: [], total: 0, page: 1, page_size: 20,
  }),
};

vi.mock("../src/api-client.js", () => {
  class MockFortyTwoClient {
    nodeId = mockClient.nodeId;
    login = mockClient.login;
    getAgent = mockClient.getAgent;
    createQuery = mockClient.createQuery;
    getCapability = mockClient.getCapability;
    resetCapability = mockClient.resetCapability;
    listActiveChallengeRounds = mockClient.listActiveChallengeRounds;
    getChallengeRound = mockClient.getChallengeRound;
    joinChallengeRound = mockClient.joinChallengeRound;
    submitChallengeAnswer = mockClient.submitChallengeAnswer;
    getCapabilityHistory = mockClient.getCapabilityHistory;
  }
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { FortyTwoClient: MockFortyTwoClient, ApiError: MockApiError };
});

vi.mock("../src/identity.js", () => ({
  loadIdentity: vi.fn().mockReturnValue({ node_id: "agent-1", node_secret: "sec" }),
  saveIdentity: vi.fn(),
  registerAgent: vi.fn().mockResolvedValue({ node_id: "new-agent", node_secret: "new-sec" }),
  resetAccount: vi.fn().mockResolvedValue({
    agent_id: "agent-1",
    capability_rank: 0,
    rank_before: 30,
    challenge_locked: "250",
    drop_amount: "250",
  }),
}));

vi.mock("../src/main.js", () => ({
  main: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/commands.js", () => ({
  executeCommand: vi.fn().mockReturnValue(["Config:", "  node_role: JUDGE"]),
}));

vi.mock("../src/setup-logic.js", () => ({
  validateModel: vi.fn().mockResolvedValue({ ok: true }),
  buildConfig: vi.fn().mockReturnValue({
    node_name: "Bot",
    node_display_name: "Bot",
    inference_type: "openrouter",
    openrouter_api_key: "key",
    self_hosted_api_base: "",
    fortytwo_api_base: "https://app.fortytwo.network/api",
    identity_file: "/tmp/identity.json",
    poll_interval: 120,
    model_name: "test",
    llm_concurrency: 40,
    llm_timeout: 120,
    min_balance: 5.0,
    node_role: "JUDGE",
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
    vi.mocked(loadIdentity).mockReturnValue({ node_id: "agent-1", node_secret: "sec" });
    vi.mocked(validateModel).mockResolvedValue({ ok: true });
    mockClient.login.mockResolvedValue({});
    mockClient.getAgent.mockResolvedValue({ profile: { node_display_name: "Bot" } });
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
      await runCli(["config", "set", "node_role", "ANSWERER"]);
      expect(executeCommand).toHaveBeenCalledWith("/config set node_role ANSWERER");
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
      "--node-name", "TestBot",
      "--inference-type", "openrouter",
      "--api-key", "sk-or-xxx",
      "--model-name", "test-model",
      "--node-role", "JUDGE",
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
      await runCli(["setup", "--node-name", "B", "--inference-type", "openrouter", "--openrouter-api-key", "k", "--model-name", "m", "--node-role", "JUDGE"]);
      expect(validateModel).toHaveBeenCalled();
    });

    it("exits on validation failure", async () => {
      const { validateModel } = await import("../src/setup-logic.js");
      vi.mocked(validateModel).mockResolvedValue({ ok: false, error: "not found" });
      await runCli(["setup", "--node-name", "B", "--inference-type", "openrouter", "--openrouter-api-key", "k", "--model-name", "m", "--node-role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on missing --name flag", async () => {
      await runCli(["setup", "--inference-type", "openrouter", "--model-name", "m", "--node-role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on invalid inference type", async () => {
      await runCli(["setup", "--node-name", "B", "--inference-type", "invalid", "--model-name", "m", "--node-role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on invalid role", async () => {
      await runCli(["setup", "--node-name", "B", "--inference-type", "openrouter", "--openrouter-api-key", "k", "--model-name", "m", "--node-role", "INVALID"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("requires self-hosted-api-base for local inference", async () => {
      await runCli(["setup", "--node-name", "B", "--inference-type", "self-hosted", "--model-name", "m", "--node-role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("works with local inference", async () => {
      await runCli(["setup", "--node-name", "B", "--inference-type", "self-hosted", "--self-hosted-api-base", "http://localhost:11434/v1", "--model-name", "m", "--node-role", "JUDGE", "--skip-validation"]);
      const { createProfile } = await import("../src/profiles.js");
      expect(createProfile).toHaveBeenCalled();
    });
  });

  describe("import", () => {
    const importFlags = [
      "--node-id", "uuid-123",
      "--node-secret", "sec-456",
      "--inference-type", "openrouter",
      "--openrouter-api-key", "sk-or-xxx",
      "--model-name", "test-model",
      "--node-role", "JUDGE",
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
      await runCli(["import", "--node-id", "a", "--node-secret", "s", "--inference-type", "bad", "--model-name", "m", "--node-role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits on invalid role", async () => {
      await runCli(["import", "--node-id", "a", "--secret", "s", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "BAD"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("validates model when no --skip-validation", async () => {
      const { validateModel } = await import("../src/setup-logic.js");
      await runCli(["import", "--node-id", "a", "--secret", "s", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "JUDGE"]);
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
      await runCli(["import", "--node-id", "a", "--secret", "s", "--inference-type", "openrouter", "--api-key", "k", "--model", "m", "--role", "JUDGE"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("works with local inference", async () => {
      await runCli(["import", "--node-id", "a", "--secret", "s", "--inference-type", "self-hosted", "--self-hosted-api-base", "http://localhost:11434/v1", "--model", "m", "--role", "JUDGE", "--skip-validation"]);
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

    it("blocks Challenger via capability pre-check", async () => {
      mockClient.getCapability.mockResolvedValue({
        agent_id: "agent-1",
        capability_rank: 10,
        node_tier: "challenger",
        is_dead_locked: false,
      });
      await runCli(["ask", "What"]);
      expect(mockClient.createQuery).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errOut = errorSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(errOut).toContain("Challenger");
    });

    it("surfaces 403 from createQuery as friendly message", async () => {
      mockClient.getCapability.mockResolvedValue({
        agent_id: "agent-1",
        capability_rank: 42,
        node_tier: "capable",
        is_dead_locked: false,
      });
      const { ApiError } = await import("../src/api-client.js");
      mockClient.createQuery.mockRejectedValue(new ApiError(403, "Challenger nodes cannot create queries."));
      await runCli(["ask", "Hi"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errOut = errorSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(errOut).toContain("Challenger");
    });
  });

  describe("capability command", () => {
    it("prints tier and rank", async () => {
      mockClient.getCapability.mockResolvedValue({
        agent_id: "agent-1",
        capability_rank: 21,
        node_tier: "challenger",
        is_dead_locked: false,
      });
      await runCli(["capability"]);
      const out = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("challenger");
      expect(out).toContain("21/42");
      expect(out).toContain("Dead locked:    no");
    });

    it("prints history", async () => {
      mockClient.getCapabilityHistory.mockResolvedValue({
        items: [
          {
            id: "h1",
            agent_id: "agent-1",
            delta: 3,
            rank_before: 10,
            rank_after: 13,
            reason: "challenge_correct",
            reference_id: null,
            created_at: "2026-04-13T10:00:00Z",
          },
        ],
        total: 1,
        page: 1,
        page_size: 20,
      });
      await runCli(["capability", "history"]);
      const out = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("+3");
      expect(out).toContain("10→13");
      expect(out).toContain("challenge_correct");
    });

    it("prints a message when history is empty", async () => {
      mockClient.getCapabilityHistory.mockResolvedValue({
        items: [], total: 0, page: 1, page_size: 20,
      });
      await runCli(["capability", "history"]);
      const out = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("No capability changes");
    });

    it("exits on unknown capability sub", async () => {
      await runCli(["capability", "bogus"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("reset command", () => {
    it("prints confirmation prompt without --yes and does not reset", async () => {
      const { resetAccount } = await import("../src/identity.js");
      await runCli(["reset"]);
      expect(resetAccount).not.toHaveBeenCalled();
      const out = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("--yes");
    });

    it("calls resetAccount with --yes", async () => {
      const { resetAccount } = await import("../src/identity.js");
      await runCli(["reset", "--yes"]);
      expect(resetAccount).toHaveBeenCalled();
    });
  });

  describe("challenge command", () => {
    it("list prints rounds", async () => {
      mockClient.listActiveChallengeRounds.mockResolvedValue({
        items: [{
          id: "round-1",
          foundation_pool_id: "fp-1",
          content: "?",
          status: "active",
          starts_at: "2026-04-13T10:00:00Z",
          ends_at: "2026-04-13T12:00:00Z",
          for_budget_total: "100",
          settled_at: null,
          winners_count: 0,
          reward_per_winner: "10",
          created_at: "2026-04-13T10:00:00Z",
          has_answered: false,
        }],
        total: 1, page: 1, page_size: 20,
      });
      await runCli(["challenge", "list"]);
      const out = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("round-1");
      expect(out).toContain("100 FOR");
    });

    it("list says so when no rounds", async () => {
      mockClient.listActiveChallengeRounds.mockResolvedValue({
        items: [], total: 0, page: 1, page_size: 20,
      });
      await runCli(["challenge", "list"]);
      const out = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("No active challenge rounds");
    });

    it("auto-joins then submits an answer", async () => {
      mockClient.getChallengeRound.mockResolvedValue({ has_joined: false });
      mockClient.joinChallengeRound.mockResolvedValue({ content: "Q?", stake_amount: "10" });
      mockClient.submitChallengeAnswer.mockResolvedValue({
        id: "ans-1", staked_amount: "10", round_id: "r1", agent_id: "a",
        content: "Yes", is_correct: null, capability_delta: 0,
        reward_amount: "0", submitted_at: "", validated_at: null,
      });
      await runCli(["challenge", "answer", "r1", "Yes"]);
      expect(mockClient.joinChallengeRound).toHaveBeenCalledWith("r1");
      expect(mockClient.submitChallengeAnswer).toHaveBeenCalledWith("r1", "Yes");
    });

    it("skips join when already joined", async () => {
      mockClient.getChallengeRound.mockResolvedValue({ has_joined: true });
      mockClient.submitChallengeAnswer.mockResolvedValue({ id: "ans-1" });
      await runCli(["challenge", "answer", "r1", "Yes"]);
      expect(mockClient.joinChallengeRound).not.toHaveBeenCalled();
      expect(mockClient.submitChallengeAnswer).toHaveBeenCalledWith("r1", "Yes");
    });

    it("answer exits when round_id or answer missing", async () => {
      await runCli(["challenge", "answer"]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockClient.submitChallengeAnswer).not.toHaveBeenCalled();
    });

    it("exits on unknown challenge sub", async () => {
      await runCli(["challenge", "bogus"]);
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
