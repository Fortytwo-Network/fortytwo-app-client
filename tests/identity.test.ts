import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  get: () => ({
    node_identity_file: "/tmp/identity.json",
  }),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  generateRsaKeypair,
  loadIdentity,
  saveIdentity,
  registerAgent,
  resetAccount,
} from "../src/identity.js";

describe("identity", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("generateRsaKeypair", () => {
    it("generates valid PEM keys", () => {
      const { privatePem, publicPem } = generateRsaKeypair();
      expect(privatePem).toContain("-----BEGIN PRIVATE KEY-----");
      expect(publicPem).toContain("-----BEGIN PUBLIC KEY-----");
    });

    it("generates unique keypairs", () => {
      const p1 = generateRsaKeypair();
      const p2 = generateRsaKeypair();
      expect(p1.privatePem).not.toBe(p2.privatePem);
    });
  });

  describe("loadIdentity", () => {
    it("returns null when file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(loadIdentity("missing.json")).toBeNull();
    });

    it("returns identity when file has valid data", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ node_id: "a1", node_secret: "s1" }));
      const id = loadIdentity("id.json");
      expect(id!.node_id).toBe("a1");
    });

    it("migrates legacy agent_id/secret fields", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ agent_id: "a1", secret: "s1" }));
      const id = loadIdentity("id.json");
      expect(id!.node_id).toBe("a1");
      expect(id!.node_secret).toBe("s1");
    });

    it("returns null when missing required fields", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ foo: "bar" }));
      expect(loadIdentity("bad.json")).toBeNull();
    });

    it("returns null on JSON parse error", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("not json");
      expect(loadIdentity("bad.json")).toBeNull();
    });
  });

  describe("saveIdentity", () => {
    it("writes identity as formatted JSON", () => {
      saveIdentity("out.json", { node_id: "a1", node_secret: "s1" });
      expect(writeFileSync).toHaveBeenCalledWith("out.json", expect.any(String));
    });
  });

  describe("registerAgent", () => {
    it("registers in one step and saves identity", async () => {
      const client = {
        register: vi.fn().mockResolvedValue({
          agent_id: "new-agent",
          secret: "new-secret",
          capability_rank: 0,
          node_tier: "challenger",
          message: "ok",
        }),
      } as any;

      const log = vi.fn();
      const identity = await registerAgent(client, "TestBot", log);

      expect(identity.node_id).toBe("new-agent");
      expect(identity.node_secret).toBe("new-secret");
      expect(identity.public_key_pem).toContain("BEGIN PUBLIC KEY");
      expect(identity.private_key_pem).toContain("BEGIN PRIVATE KEY");
      expect(writeFileSync).toHaveBeenCalled();
      expect(client.register).toHaveBeenCalledTimes(1);
      expect(client.register).toHaveBeenCalledWith(expect.stringContaining("PUBLIC KEY"), "TestBot");
    });

    it("propagates errors from the API", async () => {
      const client = {
        register: vi.fn().mockRejectedValue(new Error("boom")),
      } as any;

      await expect(registerAgent(client, "Bot", vi.fn())).rejects.toThrow("boom");
    });
  });

  describe("resetAccount", () => {
    it("calls resetCapability and returns response", async () => {
      const client = {
        resetCapability: vi.fn().mockResolvedValue({
          agent_id: "a1",
          capability_rank: 0,
          rank_before: 30,
          challenge_locked: "250",
          drop_amount: "250",
        }),
      } as any;

      const result = await resetAccount(client, vi.fn());
      expect(client.resetCapability).toHaveBeenCalledTimes(1);
      expect(result.rank_before).toBe(30);
      expect(result.drop_amount).toBe("250");
    });

    it("propagates API errors", async () => {
      const client = {
        resetCapability: vi.fn().mockRejectedValue(new Error("cooldown")),
      } as any;
      await expect(resetAccount(client, vi.fn())).rejects.toThrow("cooldown");
    });
  });
});
