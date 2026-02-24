import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  get: () => ({
    identity_file: "/tmp/identity.json",
    llm_concurrency: 5,
  }),
}));

vi.mock("../src/llm.js", () => ({
  compareForRegistration: vi.fn().mockResolvedValue(1),
}));

vi.mock("../src/utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  mapWithConcurrency: vi.fn(async (items: any[], _limit: number, fn: Function) => {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await fn(items[i], i));
    }
    return results;
  }),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateRsaKeypair, loadIdentity, saveIdentity, registerAgent, resetAccount } from "../src/identity.js";
import * as llm from "../src/llm.js";
import { sleep } from "../src/utils.js";

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
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ agent_id: "a1", secret: "s1" }));
      const id = loadIdentity("id.json");
      expect(id!.agent_id).toBe("a1");
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
      saveIdentity("out.json", { agent_id: "a1", secret: "s1" });
      expect(writeFileSync).toHaveBeenCalledWith("out.json", expect.any(String));
    });
  });

  describe("registerAgent", () => {
    it("registers on first attempt when passed", async () => {
      const client = {
        register: vi.fn().mockResolvedValue({
          challenge_session_id: "sess",
          challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
          required_correct: 1,
        }),
        completeRegistration: vi.fn().mockResolvedValue({
          passed: true, agent_id: "new-agent", secret: "new-secret", correct_count: 1,
        }),
      } as any;

      vi.mocked(llm.compareForRegistration).mockResolvedValue(1);
      const identity = await registerAgent(client, "TestBot", vi.fn());
      expect(identity.agent_id).toBe("new-agent");
      expect(identity.secret).toBe("new-secret");
      expect(writeFileSync).toHaveBeenCalled();
    });

    it("handles net > 0 (choice 0) and net < 0 (choice 1)", async () => {
      const client = {
        register: vi.fn().mockResolvedValue({
          challenge_session_id: "sess",
          challenges: [
            { id: "c1", question: "q1", option_a: "a1", option_b: "b1" },
            { id: "c2", question: "q2", option_a: "a2", option_b: "b2" },
          ],
          required_correct: 1,
        }),
        completeRegistration: vi.fn().mockResolvedValue({
          passed: true, agent_id: "a", secret: "s", correct_count: 2,
        }),
      } as any;

      // For c1: forward=1, inverse=-1 → net = 1+1 = 2 > 0 → choice 0
      // For c2: forward=-1, inverse=1 → net = -1-1 = -2 < 0 → choice 1
      vi.mocked(llm.compareForRegistration)
        .mockResolvedValueOnce(1)   // c1 forward
        .mockResolvedValueOnce(-1)  // c1 inverse
        .mockResolvedValueOnce(-1)  // c2 forward
        .mockResolvedValueOnce(1);  // c2 inverse

      const identity = await registerAgent(client, "Bot", vi.fn());
      expect(identity.agent_id).toBe("a");
    });

    it("handles challenge timeout (compareForRegistration throws)", async () => {
      const client = {
        register: vi.fn().mockResolvedValue({
          challenge_session_id: "sess",
          challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
          required_correct: 1,
        }),
        completeRegistration: vi.fn().mockResolvedValue({
          passed: true, agent_id: "a", secret: "s", correct_count: 1,
        }),
      } as any;

      // Reject during parallel phase (2 calls), then succeed during tiebreak
      vi.mocked(llm.compareForRegistration)
        .mockRejectedValueOnce(new Error("timeout"))
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue(1);  // tiebreak succeeds → net becomes non-zero
      const identity = await registerAgent(client, "Bot", vi.fn());
      expect(identity.agent_id).toBe("a");
    });

    it("retries when registration fails", async () => {
      let attempt = 0;
      const client = {
        register: vi.fn().mockResolvedValue({
          challenge_session_id: "sess",
          challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
          required_correct: 1,
        }),
        completeRegistration: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt < 2) return { passed: false, correct_count: 0 };
          return { passed: true, agent_id: "a", secret: "s", correct_count: 1 };
        }),
      } as any;

      vi.mocked(llm.compareForRegistration).mockResolvedValue(1);
      const identity = await registerAgent(client, "Bot", vi.fn());
      expect(identity.agent_id).toBe("a");
      expect(client.completeRegistration).toHaveBeenCalledTimes(2);
    });

    it("retries on network error", async () => {
      let attempt = 0;
      const client = {
        register: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt < 2) throw new Error("network");
          return {
            challenge_session_id: "sess",
            challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
            required_correct: 1,
          };
        }),
        completeRegistration: vi.fn().mockResolvedValue({
          passed: true, agent_id: "a", secret: "s", correct_count: 1,
        }),
      } as any;

      vi.mocked(llm.compareForRegistration).mockResolvedValue(1);
      const identity = await registerAgent(client, "Bot", vi.fn());
      expect(identity.agent_id).toBe("a");
      expect(sleep).toHaveBeenCalled();
    });
  });

  describe("resetAccount", () => {
    it("resets on first attempt", async () => {
      const client = {
        startAccountReset: vi.fn().mockResolvedValue({
          challenge_session_id: "sess",
          challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
          required_correct: 1,
          cooldown_minutes: 10,
        }),
        completeAccountReset: vi.fn().mockResolvedValue({ passed: true }),
      } as any;

      vi.mocked(llm.compareForRegistration).mockResolvedValue(1);
      await resetAccount(client, vi.fn());
      expect(client.completeAccountReset).toHaveBeenCalled();
    });

    it("retries when reset fails", async () => {
      let attempt = 0;
      const client = {
        startAccountReset: vi.fn().mockResolvedValue({
          challenge_session_id: "sess",
          challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
          required_correct: 1, cooldown_minutes: 0,
        }),
        completeAccountReset: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt < 2) return { passed: false, correct_count: 0 };
          return { passed: true };
        }),
      } as any;

      vi.mocked(llm.compareForRegistration).mockResolvedValue(1);
      await resetAccount(client, vi.fn());
      expect(client.completeAccountReset).toHaveBeenCalledTimes(2);
    });

    it("handles cooldown error", async () => {
      let attempt = 0;
      const client = {
        startAccountReset: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt < 2) throw new Error("cooldown period");
          return {
            challenge_session_id: "sess",
            challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
            required_correct: 1,
          };
        }),
        completeAccountReset: vi.fn().mockResolvedValue({ passed: true }),
      } as any;

      vi.mocked(llm.compareForRegistration).mockResolvedValue(1);
      await resetAccount(client, vi.fn());
      expect(sleep).toHaveBeenCalledWith(600_000);
    });

    it("handles generic error with retry", async () => {
      let attempt = 0;
      const client = {
        startAccountReset: vi.fn().mockImplementation(async () => {
          attempt++;
          if (attempt < 2) throw new Error("server error");
          return {
            challenge_session_id: "sess",
            challenges: [{ id: "c1", question: "q", option_a: "a", option_b: "b" }],
            required_correct: 1,
          };
        }),
        completeAccountReset: vi.fn().mockResolvedValue({ passed: true }),
      } as any;

      vi.mocked(llm.compareForRegistration).mockResolvedValue(1);
      await resetAccount(client, vi.fn());
      expect(sleep).toHaveBeenCalledWith(10_000);
    });
  });
});
