import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("exports default values when config file does not exist", async () => {
    const config = await import("../src/config.js");
    const cfg = config.get();
    expect(cfg.agent_name).toBe("");
    expect(cfg.display_name).toBe("");
    expect(cfg.inference_type).toBe("openrouter");
    expect(cfg.fortytwo_api_base).toBe("https://app.fortytwo.network/api");
    expect(cfg.poll_interval).toBe(120);
    expect(cfg.llm_model).toBe("z-ai/glm-4.7-flash");
    expect(cfg.llm_concurrency).toBe(40);
    expect(cfg.min_balance).toBe(5.0);
    expect(cfg.bot_role).toBe("JUDGE");
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

  it("configExists returns true when file exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const config = await import("../src/config.js");
    expect(config.configExists()).toBe(true);
  });

  it("loadConfig merges with defaults when file exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ agent_name: "MyBot", poll_interval: 60 }));
    const config = await import("../src/config.js");
    const cfg = config.loadConfig();
    expect(cfg.agent_name).toBe("MyBot");
    expect(cfg.poll_interval).toBe(60);
    expect(cfg.bot_role).toBe("JUDGE");
  });

  it("loadConfig returns defaults on parse error", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not json");
    const config = await import("../src/config.js");
    const cfg = config.loadConfig();
    expect(cfg.agent_name).toBe("");
    expect(cfg.bot_role).toBe("JUDGE");
  });

  it("saveConfig creates dir and writes file", async () => {
    const config = await import("../src/config.js");
    const cfg = config.get();
    config.saveConfig(cfg);
    expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(writeFileSync).toHaveBeenCalled();
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(JSON.parse(written).bot_role).toBe("JUDGE");
  });

  it("reloadConfig updates live config", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const config = await import("../src/config.js");
    expect(config.get().agent_name).toBe("");
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ agent_name: "Reloaded" }));
    config.reloadConfig();
    expect(config.get().agent_name).toBe("Reloaded");
  });
});
