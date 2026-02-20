import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports default values when config file does not exist", async () => {
    const config = await import("../src/config.js");
    const cfg = config.get();

    expect(cfg.agent_name).toBe("");
    expect(cfg.display_name).toBe("");
    expect(cfg.inference_type).toBe("openrouter");
    expect(cfg.openrouter_api_key).toBe("");
    expect(cfg.llm_api_base).toBe("");
    expect(cfg.fortytwo_api_base).toBe("https://app.fortytwo.network/api");
    expect(cfg.poll_interval).toBe(120);
    expect(cfg.llm_model).toBe("z-ai/glm-4.7-flash");
    expect(cfg.llm_concurrency).toBe(40);
    expect(cfg.llm_timeout).toBe(120);
    expect(cfg.min_balance).toBe(5.0);
    expect(cfg.bot_role).toBe("JUDGE");
    expect(cfg.answerer_system_prompt).toBe("You are a helpful assistant.");
  });

  it("has correct hardcoded constants", async () => {
    const config = await import("../src/config.js");
    expect(config.BT_MAX_ITERATIONS).toBe(1000);
    expect(config.BT_CONVERGENCE_THRESHOLD).toBe(1e-6);
    expect(config.MIN_DEADLINE_SECONDS).toBe(300);
  });

  it("configExists returns false when file is missing", async () => {
    const config = await import("../src/config.js");
    expect(config.configExists()).toBe(false);
  });
});
