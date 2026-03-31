import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  rmSync: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  CONFIG_DIR: "/tmp/.fortytwo",
  setConfigDir: vi.fn(),
  reloadConfig: vi.fn(),
}));

vi.mock("../src/identity.js", () => ({
  loadIdentity: vi.fn().mockReturnValue(null),
}));

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { loadIdentity } from "../src/identity.js";
import { setConfigDir, reloadConfig } from "../src/config.js";

describe("profiles", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);

    delete process.env.FORTYTWO_PROFILE;
  });

  describe("sanitizeProfileName", () => {
    it("lowercases and replaces spaces with hyphens", async () => {
      const { sanitizeProfileName } = await import("../src/profiles.js");
      expect(sanitizeProfileName("My Bot")).toBe("my-bot");
    });

    it("strips special characters", async () => {
      const { sanitizeProfileName } = await import("../src/profiles.js");
      expect(sanitizeProfileName("bot@v2!")).toBe("botv2");
    });

    it("collapses multiple hyphens", async () => {
      const { sanitizeProfileName } = await import("../src/profiles.js");
      expect(sanitizeProfileName("my--bot---name")).toBe("my-bot-name");
    });

    it("trims leading/trailing hyphens", async () => {
      const { sanitizeProfileName } = await import("../src/profiles.js");
      expect(sanitizeProfileName("-bot-")).toBe("bot");
    });

    it("returns 'default' for empty result", async () => {
      const { sanitizeProfileName } = await import("../src/profiles.js");
      expect(sanitizeProfileName("")).toBe("default");
      expect(sanitizeProfileName("!!!")).toBe("default");
    });

    it("preserves underscores and digits", async () => {
      const { sanitizeProfileName } = await import("../src/profiles.js");
      expect(sanitizeProfileName("bot_v2_test")).toBe("bot_v2_test");
    });
  });

  describe("loadProfilesMeta", () => {
    it("returns null when file does not exist", async () => {
      const { loadProfilesMeta } = await import("../src/profiles.js");
      expect(loadProfilesMeta()).toBeNull();
    });

    it("parses valid JSON", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "bot", profiles: ["bot"] }),
      );
      const { loadProfilesMeta } = await import("../src/profiles.js");
      expect(loadProfilesMeta()).toEqual({ active: "bot", profiles: ["bot"] });
    });

    it("returns null on invalid JSON", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("not json");
      const { loadProfilesMeta } = await import("../src/profiles.js");
      expect(loadProfilesMeta()).toBeNull();
    });
  });

  describe("saveProfilesMeta", () => {
    it("creates dir and writes JSON", async () => {
      const { saveProfilesMeta } = await import("../src/profiles.js");
      saveProfilesMeta({ active: "test", profiles: ["test"] });
      expect(mkdirSync).toHaveBeenCalledWith("/tmp/.fortytwo", { recursive: true });
      expect(writeFileSync).toHaveBeenCalled();
      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(JSON.parse(written)).toEqual({ active: "test", profiles: ["test"] });
    });
  });

  describe("getActiveProfileName", () => {
    it("returns meta active when no override or env", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "my-bot", profiles: ["my-bot"] }),
      );
      const { getActiveProfileName } = await import("../src/profiles.js");
      expect(getActiveProfileName()).toBe("my-bot");
    });

    it("returns 'default' when no meta exists", async () => {
      const { getActiveProfileName } = await import("../src/profiles.js");
      expect(getActiveProfileName()).toBe("default");
    });

    it("env var overrides meta", async () => {
      process.env.FORTYTWO_PROFILE = "env-bot";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "meta-bot", profiles: ["meta-bot"] }),
      );
      const { getActiveProfileName } = await import("../src/profiles.js");
      expect(getActiveProfileName()).toBe("env-bot");
    });

    it("setProfileOverride overrides env and meta", async () => {
      process.env.FORTYTWO_PROFILE = "env-bot";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "meta-bot", profiles: ["meta-bot"] }),
      );
      const { getActiveProfileName, setProfileOverride } = await import("../src/profiles.js");
      setProfileOverride("flag-bot");
      expect(getActiveProfileName()).toBe("flag-bot");

      setProfileOverride(undefined);
    });
  });

  describe("createProfile", () => {
    it("creates dir, writes config and identity, updates meta", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { createProfile } = await import("../src/profiles.js");
      const cfg = {
        agent_name: "TestBot",
        display_name: "TestBot",
        inference_type: "openrouter" as const,
        openrouter_api_key: "key",
        llm_api_base: "",
        fortytwo_api_base: "https://app.fortytwo.network/api",
        identity_file: "/old/path/identity.json",
        poll_interval: 120,
        llm_model: "test",
        llm_concurrency: 40,
        llm_timeout: 120,
        min_balance: 5.0,
        bot_role: "JUDGE",
        answerer_system_prompt: "You are a helpful assistant.",
      };

      createProfile("testbot", cfg, { agent_id: "agent-1", secret: "sec" });

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("profiles/testbot"),
        { recursive: true },
      );

      const configCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("profiles/testbot/config.json"),
      );
      expect(configCall).toBeDefined();
      const writtenCfg = JSON.parse(configCall![1] as string);
      expect(writtenCfg.identity_file).toContain("profiles/testbot/identity.json");
      expect(writtenCfg.agent_name).toBe("TestBot");

      const idCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("profiles/testbot/identity.json"),
      );
      expect(idCall).toBeDefined();
      const writtenId = JSON.parse(idCall![1] as string);
      expect(writtenId.agent_id).toBe("agent-1");

      const metaCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("profiles.json"),
      );
      expect(metaCall).toBeDefined();
      const writtenMeta = JSON.parse(metaCall![1] as string);
      expect(writtenMeta.active).toBe("testbot");
      expect(writtenMeta.profiles).toContain("testbot");

      expect(setConfigDir).toHaveBeenCalledWith(expect.stringContaining("profiles/testbot"));
      expect(reloadConfig).toHaveBeenCalled();
    });

    it("does not write identity file when no identity provided", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { createProfile } = await import("../src/profiles.js");
      const cfg = {
        agent_name: "Bot", display_name: "Bot", inference_type: "openrouter" as const,
        openrouter_api_key: "", llm_api_base: "", fortytwo_api_base: "",
        identity_file: "", poll_interval: 120, llm_model: "", llm_concurrency: 40,
        llm_timeout: 120, min_balance: 5, bot_role: "JUDGE", answerer_system_prompt: "",
      };
      createProfile("bot", cfg);

      const idCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("identity.json") && !(c[0] as string).endsWith("profiles.json"),
      );
      const allPaths = vi.mocked(writeFileSync).mock.calls.map((c) => c[0] as string);
      expect(allPaths.some((p) => p.endsWith("bot/identity.json"))).toBe(false);
    });

    it("does not duplicate profile in meta", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return (path as string).endsWith("profiles.json");
      });
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "bot", profiles: ["bot"] }),
      );

      const { createProfile } = await import("../src/profiles.js");
      const cfg = {
        agent_name: "Bot", display_name: "Bot", inference_type: "openrouter" as const,
        openrouter_api_key: "", llm_api_base: "", fortytwo_api_base: "",
        identity_file: "", poll_interval: 120, llm_model: "", llm_concurrency: 40,
        llm_timeout: 120, min_balance: 5, bot_role: "JUDGE", answerer_system_prompt: "",
      };
      createProfile("bot", cfg);

      const metaCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("profiles.json"),
      );
      const writtenMeta = JSON.parse(metaCall![1] as string);
      expect(writtenMeta.profiles.filter((p: string) => p === "bot").length).toBe(1);
    });
  });

  describe("deleteProfile", () => {
    it("throws when no profiles exist", async () => {
      const { deleteProfile } = await import("../src/profiles.js");
      expect(() => deleteProfile("bot")).toThrow("No profiles found");
    });

    it("throws when deleting active profile", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "bot", profiles: ["bot", "other"] }),
      );
      const { deleteProfile } = await import("../src/profiles.js");
      expect(() => deleteProfile("bot")).toThrow("Cannot delete the active profile");
    });

    it("throws when profile not found", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "bot", profiles: ["bot"] }),
      );
      const { deleteProfile } = await import("../src/profiles.js");
      expect(() => deleteProfile("nonexistent")).toThrow('not found');
    });

    it("removes profile dir and updates meta", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "bot", profiles: ["bot", "other"] }),
      );
      const { deleteProfile } = await import("../src/profiles.js");
      deleteProfile("other");

      expect(rmSync).toHaveBeenCalledWith(
        expect.stringContaining("profiles/other"),
        { recursive: true, force: true },
      );

      const metaCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("profiles.json"),
      );
      const writtenMeta = JSON.parse(metaCall![1] as string);
      expect(writtenMeta.profiles).toEqual(["bot"]);
      expect(writtenMeta.active).toBe("bot");
    });
  });

  describe("switchProfile", () => {
    it("throws when no profiles exist", async () => {
      const { switchProfile } = await import("../src/profiles.js");
      expect(() => switchProfile("bot")).toThrow("No profiles found");
    });

    it("throws when profile not found", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "bot", profiles: ["bot"] }),
      );
      const { switchProfile } = await import("../src/profiles.js");
      expect(() => switchProfile("nonexistent")).toThrow("not found");
    });

    it("updates meta and calls setConfigDir + reloadConfig", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "bot", profiles: ["bot", "other"] }),
      );
      const { switchProfile } = await import("../src/profiles.js");
      switchProfile("other");

      const metaCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("profiles.json"),
      );
      const writtenMeta = JSON.parse(metaCall![1] as string);
      expect(writtenMeta.active).toBe("other");

      expect(setConfigDir).toHaveBeenCalledWith(expect.stringContaining("profiles/other"));
      expect(reloadConfig).toHaveBeenCalled();
    });
  });

  describe("listProfiles", () => {
    it("returns empty array when no meta", async () => {
      const { listProfiles } = await import("../src/profiles.js");
      expect(listProfiles()).toEqual([]);
    });

    it("returns empty array when no profiles in meta", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ active: "default", profiles: [] }),
      );
      const { listProfiles } = await import("../src/profiles.js");
      expect(listProfiles()).toEqual([]);
    });

    it("returns profile info with active marker", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((path) => {
        const p = path as string;
        if (p.endsWith("profiles.json")) {
          return JSON.stringify({ active: "bot-a", profiles: ["bot-a", "bot-b"] });
        }
        if (p.includes("bot-a") && p.endsWith("config.json")) {
          return JSON.stringify({ agent_name: "BotA" });
        }
        if (p.includes("bot-b") && p.endsWith("config.json")) {
          return JSON.stringify({ agent_name: "BotB" });
        }
        return "{}";
      });
      vi.mocked(loadIdentity).mockImplementation((path) => {
        if (path.includes("bot-a")) return { agent_id: "id-aaa-bbb", secret: "s" };
        return null;
      });

      const { listProfiles } = await import("../src/profiles.js");
      const profiles = listProfiles();

      expect(profiles).toHaveLength(2);
      expect(profiles[0]).toEqual({
        name: "bot-a",
        active: true,
        agentName: "BotA",
        agentId: "id-aaa-bbb",
      });
      expect(profiles[1]).toEqual({
        name: "bot-b",
        active: false,
        agentName: "BotB",
        agentId: "",
      });
    });
  });

  describe("migrateIfNeeded", () => {
    it("does nothing when profiles.json already exists", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return (path as string).endsWith("profiles.json");
      });
      const { migrateIfNeeded } = await import("../src/profiles.js");
      migrateIfNeeded();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("creates empty meta for fresh install (no legacy config)", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { migrateIfNeeded } = await import("../src/profiles.js");
      migrateIfNeeded();

      expect(writeFileSync).toHaveBeenCalledTimes(1);
      const metaCall = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(metaCall[1] as string);
      expect(written).toEqual({ active: "default", profiles: [] });
    });

    it("migrates legacy config and identity", async () => {
      const legacyCfg = {
        agent_name: "My Judge Bot",
        inference_type: "openrouter",
        identity_file: "/tmp/.fortytwo/identity.json",
      };
      const legacyIdentity = JSON.stringify({ agent_id: "old-id", secret: "old-sec" });

      vi.mocked(existsSync).mockImplementation((path) => {
        const p = path as string;
        if (p.endsWith("profiles.json")) return false;
        if (p.endsWith(".fortytwo/config.json")) return true;
        if (p.endsWith(".fortytwo/identity.json")) return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((path) => {
        const p = path as string;
        if (p.endsWith(".fortytwo/config.json")) return JSON.stringify(legacyCfg);
        if (p.endsWith(".fortytwo/identity.json")) return legacyIdentity;
        throw new Error(`Unexpected read: ${p}`);
      });

      const { migrateIfNeeded } = await import("../src/profiles.js");
      migrateIfNeeded();

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("profiles/my-judge-bot"),
        { recursive: true },
      );

      const cfgCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).includes("profiles/my-judge-bot/config.json"),
      );
      expect(cfgCall).toBeDefined();
      const writtenCfg = JSON.parse(cfgCall![1] as string);
      expect(writtenCfg.identity_file).toContain("profiles/my-judge-bot/identity.json");
      expect(writtenCfg.agent_name).toBe("My Judge Bot");

      const idCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).includes("profiles/my-judge-bot/identity.json"),
      );
      expect(idCall).toBeDefined();
      expect(idCall![1]).toBe(legacyIdentity);

      const metaCall = vi.mocked(writeFileSync).mock.calls.find(
        (c) => (c[0] as string).endsWith("profiles.json"),
      );
      expect(metaCall).toBeDefined();
      const writtenMeta = JSON.parse(metaCall![1] as string);
      expect(writtenMeta.active).toBe("my-judge-bot");
      expect(writtenMeta.profiles).toEqual(["my-judge-bot"]);
    });

    it("handles corrupt legacy config gracefully", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        const p = path as string;
        if (p.endsWith("profiles.json")) return false;
        if (p.endsWith(".fortytwo/config.json")) return true;
        return false;
      });
      vi.mocked(readFileSync).mockReturnValue("not valid json");

      const { migrateIfNeeded } = await import("../src/profiles.js");
      migrateIfNeeded();

      const metaCall = vi.mocked(writeFileSync).mock.calls[0];
      const written = JSON.parse(metaCall[1] as string);
      expect(written).toEqual({ active: "default", profiles: [] });
    });
  });

  describe("initProfiles", () => {
    it("calls migrateIfNeeded, setConfigDir and reloadConfig", async () => {

      vi.mocked(existsSync).mockReturnValue(false);
      const { initProfiles } = await import("../src/profiles.js");
      initProfiles();

      expect(setConfigDir).toHaveBeenCalledWith(expect.stringContaining("profiles/"));
      expect(reloadConfig).toHaveBeenCalled();
    });
  });

  describe("profileExists", () => {
    it("returns false when config.json does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { profileExists } = await import("../src/profiles.js");
      expect(profileExists("bot")).toBe(false);
    });

    it("returns true when config.json exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const { profileExists } = await import("../src/profiles.js");
      expect(profileExists("bot")).toBe(true);
    });
  });
});
