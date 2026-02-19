import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateRsaKeypair, loadIdentity, saveIdentity } from "../src/identity.js";

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";

describe("identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateRsaKeypair", () => {
    it("generates valid PEM keys", () => {
      const { privatePem, publicPem } = generateRsaKeypair();
      expect(privatePem).toContain("-----BEGIN PRIVATE KEY-----");
      expect(privatePem).toContain("-----END PRIVATE KEY-----");
      expect(publicPem).toContain("-----BEGIN PUBLIC KEY-----");
      expect(publicPem).toContain("-----END PUBLIC KEY-----");
    });

    it("generates unique keypairs each call", () => {
      const pair1 = generateRsaKeypair();
      const pair2 = generateRsaKeypair();
      expect(pair1.privatePem).not.toBe(pair2.privatePem);
      expect(pair1.publicPem).not.toBe(pair2.publicPem);
    });
  });

  describe("loadIdentity", () => {
    it("returns null when file does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(loadIdentity("missing.json")).toBeNull();
    });

    it("returns identity when file has valid data", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          agent_id: "agent-1",
          secret: "sec-1",
          public_key_pem: "pub",
          private_key_pem: "priv",
        }),
      );
      const identity = loadIdentity("identity.json");
      expect(identity).not.toBeNull();
      expect(identity!.agent_id).toBe("agent-1");
      expect(identity!.secret).toBe("sec-1");
    });

    it("returns null when file is missing required fields", () => {
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
      const identity = {
        agent_id: "agent-1",
        secret: "sec-1",
        public_key_pem: "pub",
        private_key_pem: "priv",
      };
      saveIdentity("out.json", identity);
      expect(writeFileSync).toHaveBeenCalledWith("out.json", JSON.stringify(identity, null, 2));
    });
  });
});
