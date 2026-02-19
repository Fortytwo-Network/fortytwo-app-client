import * as config from "./config.js";
import { sleep, verbose } from "./utils.js";

export class FortyTwoClient {
  private baseUrl: string;
  agentId = "";
  private secret = "";
  private accessToken = "";
  private refreshTokenValue = "";
  private tokenExpiresAt = 0;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? config.get().fortytwo_api_base).replace(/\/+$/, "");
  }

  // ── Auth ──────────────────────────────────────────────────────

  async login(agentId: string, secret: string): Promise<Record<string, any>> {
    this.agentId = agentId;
    this.secret = secret;
    const data = await this.request("POST", "/auth/login", {
      body: { agent_id: agentId, secret },
      auth: false,
    });
    this.storeTokens(data);
    return data;
  }

  async refresh(): Promise<Record<string, any>> {
    if (!this.refreshTokenValue) throw new Error("No refresh token available");
    const data = await this.request("POST", "/auth/refresh", {
      body: { refresh_token: this.refreshTokenValue },
      auth: false,
    });
    this.storeTokens(data);
    return data;
  }

  private storeTokens(data: Record<string, any>): void {
    const tokens = data.tokens ?? {};
    this.accessToken = tokens.access_token ?? "";
    this.refreshTokenValue = tokens.refresh_token ?? "";
    const expiresIn = tokens.expires_in ?? 900;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;
  }

  // ── Registration ──────────────────────────────────────────────

  async register(publicKeyPem: string, displayName?: string): Promise<Record<string, any>> {
    const payload: Record<string, any> = { public_key: publicKeyPem };
    if (displayName) payload.display_name = displayName;
    return this.request("POST", "/auth/register", { body: payload, auth: false });
  }

  async completeRegistration(sessionId: string, responses: Record<string, any>[]): Promise<Record<string, any>> {
    return this.request("POST", "/auth/register/complete", {
      body: { challenge_session_id: sessionId, responses },
      auth: false,
    });
  }

  // ── Rankings ──────────────────────────────────────────────────

  async getPendingChallenges(page = 1, pageSize = 20): Promise<Record<string, any>> {
    return this.request("GET", `/rankings/pending/${this.agentId}`, {
      params: { page, page_size: pageSize },
    });
  }

  async getChallenge(challengeId: string): Promise<Record<string, any>> {
    return this.request("GET", `/rankings/challenges/${challengeId}`);
  }

  async joinChallenge(challengeId: string): Promise<Record<string, any>> {
    return this.request("POST", `/rankings/challenges/${challengeId}/join`);
  }

  async getChallengeAnswers(challengeId: string): Promise<Record<string, any>> {
    return this.request("GET", `/rankings/challenges/${challengeId}/answers`);
  }

  async submitVote(
    challengeId: string,
    answerRankings: string[],
    goodAnswers: string[],
  ): Promise<Record<string, any>> {
    return this.request("POST", "/rankings/votes", {
      body: { challenge_id: challengeId, answer_rankings: answerRankings, good_answers: goodAnswers },
    });
  }

  // ── Queries & Answers ────────────────────────────────────────

  async getActiveQueries(page = 1, pageSize = 50): Promise<Record<string, any>> {
    return this.request("GET", "/queries/active", {
      params: { page, page_size: pageSize },
    });
  }

  async getQuery(queryId: string): Promise<Record<string, any>> {
    return this.request("GET", `/queries/${queryId}`);
  }

  async joinQuery(queryId: string): Promise<Record<string, any>> {
    return this.request("POST", `/queries/${queryId}/join`);
  }

  async submitAnswer(queryId: string, encryptedContent: string): Promise<Record<string, any>> {
    return this.request("POST", `/queries/${queryId}/answers`, {
      body: { encrypted_content: encryptedContent },
    });
  }

  // ── Account Reset ─────────────────────────────────────────────

  async startAccountReset(): Promise<Record<string, any>> {
    return this.request("POST", "/auth/reset/start");
  }

  async completeAccountReset(sessionId: string, responses: Record<string, any>[]): Promise<Record<string, any>> {
    return this.request("POST", "/auth/reset/complete", {
      body: { challenge_session_id: sessionId, responses },
    });
  }

  // ── Economy ───────────────────────────────────────────────────

  async getBalance(): Promise<Record<string, any>> {
    return this.request("GET", `/economy/balance/${this.agentId}`);
  }

  // ── Internal ──────────────────────────────────────────────────

  private async ensureAuthenticated(): Promise<void> {
    if (!this.accessToken) {
      if (this.agentId && this.secret) {
        await this.login(this.agentId, this.secret);
      }
      return;
    }
    if (Date.now() >= this.tokenExpiresAt - 60_000) {
      try {
        await this.refresh();
      } catch {
        if (this.agentId && this.secret) {
          await this.login(this.agentId, this.secret);
        }
      }
    }
  }

  async request(
    method: string,
    path: string,
    opts: {
      body?: Record<string, any>;
      params?: Record<string, any>;
      auth?: boolean;
      maxRetries?: number;
    } = {},
  ): Promise<Record<string, any>> {
    const { body, params, auth = true, maxRetries = 3 } = opts;
    let url = `${this.baseUrl}${path}`;

    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        qs.set(k, String(v));
      }
      url += `?${qs.toString()}`;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (auth) await this.ensureAuthenticated();

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (auth && this.accessToken) {
        headers["Authorization"] = `Bearer ${this.accessToken}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      verbose(`→ ${method} ${url}${body ? ` body=${JSON.stringify(body).slice(0, 200)}` : ""}`);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        verbose(`✗ ${method} ${path} — network error: ${err}`);
        if (attempt < maxRetries) {
          const wait = 2 ** attempt * 1000;
          await sleep(wait);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }

      verbose(`← ${resp.status} ${method} ${path}`);

      // 401: try refreshing tokens once
      if (resp.status === 401 && auth && attempt === 0) {
        try {
          if (this.agentId && this.secret) {
            await this.login(this.agentId, this.secret);
          }
        } catch { /* ignore */ }
        continue;
      }

      // 429: rate limited
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("Retry-After") ?? String(2 ** attempt * 2), 10);
        const wait = Math.min(retryAfter, 60) * 1000;
        await sleep(wait);
        continue;
      }

      // 5xx: server error
      if (resp.status >= 500 && attempt < maxRetries) {
        const wait = 2 ** attempt * 1000;
        await sleep(wait);
        continue;
      }

      if (resp.status >= 400) {
        const text = await resp.text();
        throw new Error(`API error ${resp.status} on ${method} ${path}: ${text.slice(0, 500)}`);
      }

      return (await resp.json()) as Record<string, any>;
    }

    throw new Error(`Request to ${method} ${path} failed after ${maxRetries + 1} attempts`);
  }
}
