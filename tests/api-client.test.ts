import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    fortytwo_api_base: "https://api.test.com",
  }),
}));

vi.mock("../src/utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  verbose: vi.fn(),
}));

import { FortyTwoClient } from "../src/api-client.js";

describe("FortyTwoClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function mockFetch(response: any, status = 200) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
      headers: new Headers(),
    } as any);
  }

  function mockFetchSequence(...responses: Array<{ response: any; status: number; headers?: Headers }>) {
    const fn = vi.fn();
    for (const r of responses) {
      fn.mockResolvedValueOnce({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.response,
        text: async () => JSON.stringify(r.response),
        headers: r.headers ?? new Headers(),
      });
    }
    globalThis.fetch = fn;
    return fn;
  }

  it("login stores tokens and agent info", async () => {
    mockFetch({ tokens: { access_token: "at-123", refresh_token: "rt-456", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.login("agent-1", "secret-1");
    expect(data.tokens.access_token).toBe("at-123");
    expect(client.nodeId).toBe("agent-1");
  });

  it("adds auth header for authenticated requests", async () => {
    mockFetch({ tokens: { access_token: "at-123", refresh_token: "rt-456", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret-1");

    mockFetch({ challenges: [] });
    await client.getPendingChallenges();
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].headers["Authorization"]).toBe("Bearer at-123");
  });

  it("appends query params for GET requests", async () => {
    mockFetch({ tokens: { access_token: "at-123", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret-1");

    mockFetch({ queries: [] });
    await client.getActiveQueries(2, 25);
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("page=2");
    expect(call[0]).toContain("page_size=25");
  });

  it("retries on 5xx errors", async () => {
    const fn = mockFetchSequence(
      { response: "error", status: 500 },
      { response: { success: true }, status: 200 },
    );
    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.request("GET", "/test", { auth: false });
    expect(data.success).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws on persistent 4xx errors", async () => {
    mockFetch({ error: "not found" }, 404);
    const client = new FortyTwoClient("https://api.test.com");
    await expect(client.request("GET", "/missing", { auth: false })).rejects.toThrow();
  });

  it("extracts detail from 4xx JSON response", async () => {
    mockFetch({ detail: "Intelligence rank too low" }, 400);
    const client = new FortyTwoClient("https://api.test.com");
    await expect(client.request("GET", "/test", { auth: false })).rejects.toThrow("Intelligence rank too low");
  });

  it("register sends public key", async () => {
    mockFetch({ challenge_session_id: "sess-1", challenges: [] });
    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.register("-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----", "MyBot");
    expect(data.challenge_session_id).toBe("sess-1");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.display_name).toBe("MyBot");
  });

  it("register without displayName omits it", async () => {
    mockFetch({ challenge_session_id: "sess-1", challenges: [] });
    const client = new FortyTwoClient("https://api.test.com");
    await client.register("pubkey");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.display_name).toBeUndefined();
  });

  it("refresh sends refresh token", async () => {
    // Login first
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt-orig", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("a", "s");

    // Refresh
    mockFetch({ tokens: { access_token: "at-new", refresh_token: "rt-new", expires_in: 900 } });
    await client.refresh();

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.refresh_token).toBe("rt-orig");
  });

  it("refresh throws when no refresh token", async () => {
    const client = new FortyTwoClient("https://api.test.com");
    await expect(client.refresh()).rejects.toThrow("No refresh token");
  });

  it("handles 401 by re-login", async () => {
    const fn = mockFetchSequence(
      // Login
      { response: { tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } }, status: 200 },
      // First authenticated request → 401
      { response: {}, status: 401 },
      // Re-login
      { response: { tokens: { access_token: "at-new", refresh_token: "rt-new", expires_in: 900 } }, status: 200 },
      // Retry
      { response: { data: "ok" }, status: 200 },
    );

    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret-1");
    const data = await client.request("GET", "/protected", { maxRetries: 1 });
    expect(data.data).toBe("ok");
  });

  it("handles 429 rate limiting", async () => {
    const headers = new Headers({ "Retry-After": "1" });
    const fn = mockFetchSequence(
      { response: {}, status: 429, headers },
      { response: { ok: true }, status: 200 },
    );

    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.request("GET", "/test", { auth: false });
    expect(data.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on network error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        headers: new Headers(),
      });
    globalThis.fetch = fn;

    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.request("GET", "/test", { auth: false });
    expect(data.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max retries on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new FortyTwoClient("https://api.test.com");
    await expect(client.request("GET", "/test", { auth: false, maxRetries: 1 })).rejects.toThrow("ECONNREFUSED");
  });

  it("completeRegistration sends session and responses", async () => {
    mockFetch({ passed: true, agent_id: "a1", secret: "s1" });
    const client = new FortyTwoClient("https://api.test.com");
    const result = await client.completeRegistration("sess-1", [{ challenge_id: "c1", choice: 0 }]);
    expect(result.passed).toBe(true);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.challenge_session_id).toBe("sess-1");
  });

  it("getBalance calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");

    mockFetch({ available: "100.0" });
    const data = await client.getBalance();
    expect(data.available).toBe("100.0");
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain("/economy/balance/agent-1");
  });

  it("getAgent calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");

    mockFetch({ profile: { display_name: "Bot" } });
    const data = await client.getAgent();
    expect(data.profile.display_name).toBe("Bot");
  });

  it("createQuery sends encrypted content", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");

    mockFetch({ id: "q1" });
    const data = await client.createQuery("base64content", "general");
    expect(data.id).toBe("q1");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.encrypted_content).toBe("base64content");
  });

  it("joinQuery calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");

    mockFetch({ stake_amount: "1.0" });
    const data = await client.joinQuery("q1");
    expect(data.stake_amount).toBe("1.0");
  });

  it("submitAnswer sends encrypted content", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");

    mockFetch({ id: "ans-1" });
    const data = await client.submitAnswer("q1", "encrypted");
    expect(data.id).toBe("ans-1");
  });

  it("submitVote sends rankings", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");

    mockFetch({ vote_id: "v1" });
    const data = await client.submitVote("ch1", ["a1", "a2"], ["a1"]);
    expect(data.vote_id).toBe("v1");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.answer_rankings).toEqual(["a1", "a2"]);
    expect(body.good_answers).toEqual(["a1"]);
  });

  it("startAccountReset calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");

    mockFetch({ challenge_session_id: "sess" });
    const data = await client.startAccountReset();
    expect(data.challenge_session_id).toBe("sess");
  });

  it("throws after all retries exhausted", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "error",
      headers: new Headers(),
    });
    const client = new FortyTwoClient("https://api.test.com");
    await expect(client.request("GET", "/test", { auth: false, maxRetries: 0 })).rejects.toThrow();
  });

  it("ensureAuthenticated logs in when no access token", async () => {
    const fn = mockFetchSequence(
      // login (triggered by ensureAuthenticated)
      { response: { tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } }, status: 200 },
      // actual request
      { response: { ok: true }, status: 200 },
    );
    const client = new FortyTwoClient("https://api.test.com");
    // Set agentId and secret without calling login (no access token)
    (client as any).nodeId = "agent-1";
    (client as any).nodeSecret = "secret-1";
    const data = await client.request("GET", "/test");
    expect(data.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("ensureAuthenticated refreshes expired token", async () => {
    // Login first
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret-1");

    // Expire the token by setting tokenExpiresAt to past
    (client as any).tokenExpiresAt = Date.now() - 1000;

    const fn = mockFetchSequence(
      // refresh call
      { response: { tokens: { access_token: "at-new", refresh_token: "rt-new", expires_in: 900 } }, status: 200 },
      // actual request
      { response: { data: "ok" }, status: 200 },
    );
    const data = await client.request("GET", "/test");
    expect(data.data).toBe("ok");
  });

  it("ensureAuthenticated falls back to login when refresh fails", async () => {
    // Login first
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret-1");

    // Expire the token
    (client as any).tokenExpiresAt = Date.now() - 1000;

    const fn = mockFetchSequence(
      // refresh fails
      { response: { error: "bad token" }, status: 401 },
      // re-login
      { response: { tokens: { access_token: "at-new", refresh_token: "rt-new", expires_in: 900 } }, status: 200 },
      // actual request
      { response: { data: "ok" }, status: 200 },
    );
    const data = await client.request("GET", "/test");
    expect(data.data).toBe("ok");
  });

  it("getChallenge calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");
    mockFetch({ decrypted_query_content: "question" });
    const data = await client.getChallenge("ch-1");
    expect(data.decrypted_query_content).toBe("question");
  });

  it("joinChallenge calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");
    mockFetch({ stake_amount: "1.0" });
    const data = await client.joinChallenge("ch-1");
    expect(data.stake_amount).toBe("1.0");
  });

  it("getChallengeAnswers calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");
    mockFetch({ answers: [{ id: "a1" }] });
    const data = await client.getChallengeAnswers("ch-1");
    expect(data.answers[0].id).toBe("a1");
  });

  it("getQuery calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");
    mockFetch({ decrypted_content: "What?" });
    const data = await client.getQuery("q-1");
    expect(data.decrypted_content).toBe("What?");
  });

  it("completeAccountReset sends session and responses", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");
    mockFetch({ passed: true });
    const data = await client.completeAccountReset("sess-1", [{ challenge_id: "c1", choice: 0 }]);
    expect(data.passed).toBe(true);
  });

  it("getAgentStats calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");
    mockFetch({ total_votes: 10 });
    const data = await client.getAgentStats();
    expect(data.total_votes).toBe(10);
  });

  it("getLikesRemaining calls correct endpoint", async () => {
    mockFetch({ tokens: { access_token: "at", refresh_token: "rt", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret");
    mockFetch({ remaining: 5 });
    const data = await client.getLikesRemaining();
    expect(data.remaining).toBe(5);
  });

  it("throws after loop exhaustion with maxRetries", async () => {
    const fn = mockFetchSequence(
      { response: {}, status: 429, headers: new Headers({ "Retry-After": "0" }) },
      { response: {}, status: 429, headers: new Headers({ "Retry-After": "0" }) },
      { response: {}, status: 429, headers: new Headers({ "Retry-After": "0" }) },
      { response: {}, status: 429, headers: new Headers({ "Retry-After": "0" }) },
    );
    const client = new FortyTwoClient("https://api.test.com");
    await expect(client.request("GET", "/test", { auth: false, maxRetries: 3 })).rejects.toThrow("failed after");
  });

  it("uses default baseUrl from config", () => {
    const client = new FortyTwoClient();
    expect((client as any).baseUrl).toBe("https://api.test.com");
  });

  it("strips trailing slashes from baseUrl", () => {
    const client = new FortyTwoClient("https://api.test.com///");
    expect((client as any).baseUrl).toBe("https://api.test.com");
  });
});
