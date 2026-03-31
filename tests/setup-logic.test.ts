import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  CONFIG_DIR: "/tmp/.fortytwo",
  getConfigDir: () => "/tmp/.fortytwo",
}));

import { validateModel, buildConfig, OPENROUTER_BASE } from "../src/setup-logic.js";

describe("setup-logic", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("OPENROUTER_BASE", () => {
    it("is the correct URL", () => {
      expect(OPENROUTER_BASE).toBe("https://openrouter.ai/api/v1");
    });
  });

  describe("validateModel", () => {
    it("returns ok for matching model", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "test-model" }] }),
      });
      const result = await validateModel({
        inference_type: "openrouter",
        openrouter_api_key: "key",
        llm_model: "test-model",
      });
      expect(result.ok).toBe(true);
    });

    it("returns error for missing model", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "other-model" }] }),
      });
      const result = await validateModel({
        inference_type: "openrouter",
        openrouter_api_key: "key",
        llm_model: "missing-model",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("returns ok when no models in response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });
      const result = await validateModel({
        inference_type: "local",
        llm_api_base: "http://localhost:11434/v1",
        llm_model: "llama3",
      });
      expect(result.ok).toBe(true);
    });

    it("returns error on network failure", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await validateModel({
        inference_type: "local",
        llm_api_base: "http://localhost:11434/v1",
        llm_model: "llama3",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cannot reach");
    });

    it("returns error on 401 for openrouter", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      const result = await validateModel({
        inference_type: "openrouter",
        openrouter_api_key: "bad-key",
        llm_model: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid API key");
    });

    it("returns error on 401 for local", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      const result = await validateModel({
        inference_type: "local",
        llm_api_base: "http://localhost:11434/v1",
        llm_model: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Auth rejected");
    });

    it("returns error on other HTTP error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      const result = await validateModel({
        inference_type: "openrouter",
        openrouter_api_key: "key",
        llm_model: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("API returned 500");
    });

    it("returns ok on unparseable JSON response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => { throw new Error("bad json"); },
      });
      const result = await validateModel({
        inference_type: "openrouter",
        openrouter_api_key: "key",
        llm_model: "test",
      });
      expect(result.ok).toBe(true);
    });

    it("uses local baseURL for local inference", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "llama3" }] }),
      });
      globalThis.fetch = fetchMock;
      await validateModel({
        inference_type: "local",
        llm_api_base: "http://localhost:11434/v1/",
        llm_model: "llama3",
      });
      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/v1/models");
    });

    it("shows multiple available models in error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }, { id: "m5" }, { id: "m6" },
          ],
        }),
      });
      const result = await validateModel({
        inference_type: "openrouter",
        openrouter_api_key: "key",
        llm_model: "missing",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Model \"missing\" not found. Choose correct one and restart the client.");
    });
  });

  describe("buildConfig", () => {
    it("builds openrouter config", () => {
      const cfg = buildConfig({
        agent_name: "Bot",
        inference_type: "openrouter",
        openrouter_api_key: "sk-or-xxx",
        llm_model: "test-model",
        bot_role: "JUDGE",
      });
      expect(cfg.agent_name).toBe("Bot");
      expect(cfg.inference_type).toBe("openrouter");
      expect(cfg.openrouter_api_key).toBe("sk-or-xxx");
      expect(cfg.llm_model).toBe("test-model");
      expect(cfg.bot_role).toBe("JUDGE");
      expect(cfg.poll_interval).toBe(120);
      expect(cfg.identity_file).toContain("identity.json");
    });

    it("builds local config", () => {
      const cfg = buildConfig({
        agent_name: "LocalBot",
        inference_type: "local",
        llm_api_base: "http://localhost:11434/v1",
        llm_model: "llama3",
        bot_role: "ANSWERER",
      });
      expect(cfg.inference_type).toBe("local");
      expect(cfg.llm_api_base).toBe("http://localhost:11434/v1");
    });

    it("uses _display_name as fallback for agent_name", () => {
      const cfg = buildConfig({
        _display_name: "ServerName",
        inference_type: "openrouter",
        llm_model: "m",
      });
      expect(cfg.agent_name).toBe("ServerName");
      expect(cfg.display_name).toBe("ServerName");
    });

    it("uses agent_id as fallback when no name", () => {
      const cfg = buildConfig({
        agent_id: "uuid-123",
        inference_type: "openrouter",
        llm_model: "m",
      });
      expect(cfg.agent_name).toBe("uuid-123");
    });

    it("defaults bot_role to JUDGE", () => {
      const cfg = buildConfig({ inference_type: "openrouter", llm_model: "m" });
      expect(cfg.bot_role).toBe("JUDGE");
    });

    it("defaults llm_model for openrouter", () => {
      const cfg = buildConfig({ inference_type: "openrouter" });
      expect(cfg.llm_model).toBe("qwen/qwen3.5-35b-a3b");
    });
  });
});
