import * as config from "./config.js";
import { sleep, verbose } from "./utils.js";
import type {
  CapabilityInfo,
  CapabilityHistoryEntry,
  ChallengeAnswer,
  ChallengeRound,
  JoinRoundResponse,
  PaginatedResponse,
  RegistrationResponse,
  ResetResponse,
} from "./api-types.js";

export class FortyTwoClient {
  private baseUrl: string;
  nodeId = "";
  private nodeSecret = "";
  private accessToken = "";
  private refreshTokenValue = "";
  private tokenExpiresAt = 0;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? config.get().fortytwo_api_base).replace(/\/+$/, "");
  }

  // ── Auth ──────────────────────────────────────────────────────

  async login(nodeId: string, nodeSecret: string): Promise<Record<string, any>> {
    this.nodeId = nodeId;
    this.nodeSecret = nodeSecret;
    const data = await this.request("POST", "/auth/login", {
      body: { agent_id: nodeId, secret: nodeSecret },
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

  // ── Registration  ────────────────────────

  async register(publicKeyPem: string, displayName?: string): Promise<RegistrationResponse> {
    const payload: Record<string, any> = { public_key: publicKeyPem };
    if (displayName) payload.display_name = displayName;
    return this.request<RegistrationResponse>("POST", "/auth/register", {
      body: payload,
      auth: false,
      timeout: 60_000,
    });
  }

  // ── Rankings ──────────────────────────────────────────────────

  async getPendingChallenges(page = 1, pageSize = 20): Promise<Record<string, any>> {
    return this.request("GET", `/rankings/pending/${this.nodeId}`, {
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

  async createQuery(encryptedContent: string, specialization: string): Promise<Record<string, any>> {
    return this.request("POST", "/queries", {
      body: { encrypted_content: encryptedContent, specialization },
    });
  }

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

  // ── Capability ────────────────────────────────────────────────

  async getCapability(agentId?: string): Promise<CapabilityInfo> {
    const id = agentId ?? this.nodeId;
    return this.request<CapabilityInfo>("GET", `/capability/${id}`);
  }

  async getCapabilityHistory(
    agentId?: string,
    page = 1,
    pageSize = 20,
  ): Promise<PaginatedResponse<CapabilityHistoryEntry>> {
    const id = agentId ?? this.nodeId;
    return this.request<PaginatedResponse<CapabilityHistoryEntry>>(
      "GET",
      `/capability/${id}/history`,
      { params: { page, page_size: pageSize } },
    );
  }

  async resetCapability(agentId?: string): Promise<ResetResponse> {
    const id = agentId ?? this.nodeId;
    return this.request<ResetResponse>("POST", `/capability/${id}/reset`);
  }

  // ── Foundation Pool / Capability Challenge ───────────────────

  async listActiveChallengeRounds(
    page = 1,
    pageSize = 20,
  ): Promise<PaginatedResponse<ChallengeRound>> {
    return this.request<PaginatedResponse<ChallengeRound>>(
      "GET",
      "/foundation-pool/rounds",
      { params: { page, page_size: pageSize } },
    );
  }

  async getChallengeRound(roundId: string): Promise<ChallengeRound> {
    return this.request<ChallengeRound>("GET", `/foundation-pool/rounds/${roundId}`);
  }

  async joinChallengeRound(roundId: string): Promise<JoinRoundResponse> {
    return this.request<JoinRoundResponse>(
      "POST",
      `/foundation-pool/rounds/${roundId}/join`,
    );
  }

  async submitChallengeAnswer(roundId: string, content: string): Promise<ChallengeAnswer> {
    return this.request<ChallengeAnswer>(
      "POST",
      `/foundation-pool/rounds/${roundId}/answers`,
      { body: { content } },
    );
  }

  // ── Economy ───────────────────────────────────────────────────

  async getBalance(): Promise<Record<string, any>> {
    return this.request("GET", `/economy/balance/${this.nodeId}`);
  }

  async getAgent(): Promise<Record<string, any>> {
    return this.request("GET", `/agents/${this.nodeId}`);
  }

  async getAgentStats(): Promise<Record<string, any>> {
    return this.request("GET", `/agents/${this.nodeId}/stats`);
  }

  async getLikesRemaining(): Promise<Record<string, any>> {
    return this.request("GET", "/likes/remaining");
  }

  // ── Internal ──────────────────────────────────────────────────

  private async ensureAuthenticated(): Promise<void> {
    if (!this.accessToken) {
      if (this.nodeId && this.nodeSecret) {
        await this.login(this.nodeId, this.nodeSecret);
      }
      return;
    }
    if (Date.now() >= this.tokenExpiresAt - 60_000) {
      try {
        await this.refresh();
      } catch {
        if (this.nodeId && this.nodeSecret) {
          await this.login(this.nodeId, this.nodeSecret);
        }
      }
    }
  }

  async request<T = Record<string, any>>(
    method: string,
    path: string,
    opts: {
      body?: Record<string, any>;
      params?: Record<string, any>;
      auth?: boolean;
      maxRetries?: number;
      timeout?: number;
    } = {},
  ): Promise<T> {
    const { body, params, auth = true, maxRetries = 3, timeout = 30_000 } = opts;
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

      verbose(`→ ${method} ${url}${body ? ` body=${JSON.stringify(body).slice(0, 200)}` : ""}`);

      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        verbose(`✗ ${method} ${path} — network error: ${err}`);
        if (attempt < maxRetries) {
          const wait = 2 ** attempt * 1000;
          await sleep(wait);
          continue;
        }
        throw err;
      }

      verbose(`← ${resp.status} ${method} ${path}`);

      // 401: try refreshing tokens once
      if (resp.status === 401 && auth && attempt === 0) {
        try {
          if (this.nodeId && this.nodeSecret) {
            await this.login(this.nodeId, this.nodeSecret);
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
        let detail: string | undefined;
        try {
          const parsed = JSON.parse(text).detail;
          if (typeof parsed === "string") {
            detail = parsed;
          } else if (Array.isArray(parsed)) {
            detail = parsed.map((e: any) => e.msg ?? String(e)).join("; ");
          }
        } catch {}
        const err = new ApiError(
          resp.status,
          detail || `API error ${resp.status} on ${method} ${path}: ${text.slice(0, 500)}`,
        );
        throw err;
      }

      return (await resp.json()) as T;
    }

    throw new Error(`Request to ${method} ${path} failed after ${maxRetries + 1} attempts`);
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
