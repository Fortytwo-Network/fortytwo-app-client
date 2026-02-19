import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/config.js", () => ({
  get: () => ({
    fortytwo_api_base: "https://api.test.com",
  }),
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

  it("login stores tokens and agent info", async () => {
    mockFetch({
      tokens: {
        access_token: "at-123",
        refresh_token: "rt-456",
        expires_in: 900,
      },
    });

    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.login("agent-1", "secret-1");

    expect(data.tokens.access_token).toBe("at-123");
    expect(client.agentId).toBe("agent-1");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.test.com/auth/login");
    expect(call[1].method).toBe("POST");
  });

  it("adds auth header for authenticated requests", async () => {
    // Login first
    mockFetch({ tokens: { access_token: "at-123", refresh_token: "rt-456", expires_in: 900 } });
    const client = new FortyTwoClient("https://api.test.com");
    await client.login("agent-1", "secret-1");

    // Authenticated request
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        headers: new Headers(),
      });
    globalThis.fetch = fetchMock;

    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.request("GET", "/test", { auth: false });

    expect(data.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on persistent 4xx errors", async () => {
    mockFetch({ error: "not found" }, 404);

    const client = new FortyTwoClient("https://api.test.com");
    await expect(client.request("GET", "/missing", { auth: false })).rejects.toThrow("API error 404");
  });

  it("register sends public key", async () => {
    mockFetch({ challenge_session_id: "sess-1", challenges: [] });

    const client = new FortyTwoClient("https://api.test.com");
    const data = await client.register("-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----", "MyBot");

    expect(data.challenge_session_id).toBe("sess-1");

    const call = (globalThis.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.public_key).toContain("BEGIN PUBLIC KEY");
    expect(body.display_name).toBe("MyBot");
  });
});
