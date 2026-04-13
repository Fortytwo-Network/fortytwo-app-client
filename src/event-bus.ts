import { EventEmitter } from "node:events";

// ── Types ────────────────────────────────────────────────────

export type BotState =
  | "IDLE"
  | "AUTHENTICATING"
  | "SCANNING"
  | "JOINING"
  | "THINKING"
  | "SUBMITTING"
  | "JUDGING"
  | "COOLDOWN"
  | "PAUSED"
  | "ERROR";

export type LogLevel = "info" | "success" | "warn" | "error" | "dim" | "api";

export interface ViewerLog {
  id: string;
  time: string;
  level: LogLevel;
  msg: string;
}

export interface ViewerTx {
  id: string;
  amount: string;
  transaction_type: string;
  description: string;
  created_at: string;
}

export interface JudgeDetail {
  challengeId: string;
  questionText: string;
  answers: { id: string; content: string; nodeId?: string }[];
  comparisons: { a: string; b: string; winner: string }[];
  finalRankings: string[];
  goodAnswers: string[];
  phase: "loading" | "reading_answers" | "comparing" | "ranking_all" | "submitting" | "done";
  currentPairA: string | null;
  currentPairB: string | null;
  comparisonIndex: number;
  totalComparisons: number;
  scores: Record<string, number>;
}

export interface VisibleQuery {
  id: string;
  specialization: string;
  stake: number;
  minRank: number;
  answerCount: number;
  status: string;
  questionText?: string;
  errorMsg?: string;
}

export interface ViewerStats {
  answers: number;
  judgments: number;
  energy: number;
  staked: number;
  total: number;
  weekEarned: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  cycles: number;
  uptime: number;
  rank: string;
  judgeElo: string;
  accuracy: string;
  wins: number;
  matches: number;
  activeQueryId: string | null;
  activeQuestionText: string | null;
  activeQuestionCat: string | null;
  questionsAvailable: number;
  cooldownRemaining: number;
  thinkingText: string;
  answerText: string;
  isStreaming: boolean;
  tokPerSec: number;
  stepDetail: string;
  accountInactive: boolean;
  answersSubmitted: number;
  answersWon: number;
  answerWinRate: string;
  judgmentsMade: number;
  judgmentAccuracy: string;
  queriesSubmitted: number;
  queriesCompleted: number;
  likesGiven: number;
  likesReceived: number;
  forBalance: string;
  intelligenceNormalized: string;
  judgingNormalized: string;
  challengeLocked: number;
  capabilityRank: number | null;
  nodeTier: "challenger" | "capable" | null;
  isDeadLocked: boolean;
  challengeRoundsAvailable: number;
}

export interface ViewerConfig {
  nodeId: string;
  modelName: string;
  inferenceType: string;
  provider: string;
  cycleIntervalMs: number;
  autoRestart: boolean;
}

export interface ViewerEvent {
  type: string;
  data: any;
}

function defaultStats(): ViewerStats {
  return {
    answers: 0,
    judgments: 0,
    energy: 0,
    staked: 0,
    total: 0,
    weekEarned: 0,
    lifetimeEarned: 0,
    lifetimeSpent: 0,
    cycles: 0,
    uptime: 0,
    rank: "—",
    judgeElo: "—",
    accuracy: "—",
    wins: 0,
    matches: 0,
    activeQueryId: null,
    activeQuestionText: null,
    activeQuestionCat: null,
    questionsAvailable: 0,
    cooldownRemaining: 0,
    thinkingText: "",
    answerText: "",
    isStreaming: false,
    tokPerSec: 0,
    stepDetail: "",
    accountInactive: false,
    answersSubmitted: 0,
    answersWon: 0,
    answerWinRate: "0",
    judgmentsMade: 0,
    judgmentAccuracy: "0",
    queriesSubmitted: 0,
    queriesCompleted: 0,
    likesGiven: 0,
    likesReceived: 0,
    forBalance: "0",
    intelligenceNormalized: "0",
    judgingNormalized: "0",
    challengeLocked: 0,
    capabilityRank: null,
    nodeTier: null,
    isDeadLocked: false,
    challengeRoundsAvailable: 0,
  };
}

class ViewerEventBus extends EventEmitter {
  private _state: BotState = "IDLE";
  private _isPaused = false;
  private _isRunning = false;
  private _stats: ViewerStats = defaultStats();
  private _logs: ViewerLog[] = [];
  private _txs: ViewerTx[] = [];
  private _errors: { msg: string; time: string }[] = [];
  private _queries: VisibleQuery[] = [];
  private _lastJudge: JudgeDetail | null = null;
  private _config: ViewerConfig = {
    nodeId: "",
    modelName: "",
    inferenceType: "",
    provider: "",
    cycleIntervalMs: 120_000,
    autoRestart: true,
  };
  private _startTime = 0;
  private _uptimeInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  get state() { return this._state; }
  get isPaused() { return this._isPaused; }
  get isRunning() { return this._isRunning; }
  get stats() { return { ...this._stats }; }
  get recentLogs() { return this._logs.slice(-400); }
  get transactions() { return this._txs; }
  get lastJudge() { return this._lastJudge; }
  get errors() { return this._errors.slice(-50); }
  get queries() { return this._queries; }
  get config() { return { ...this._config }; }

  getInitSnapshot(): ViewerEvent {
    return {
      type: "init",
      data: {
        state: this._state,
        isPaused: this._isPaused,
        isRunning: this._isRunning,
        stats: this.stats,
        logs: this.recentLogs,
        config: this.config,
        transactions: this._txs,
        lastJudge: this._lastJudge,
        errors: this.errors,
        queries: this._queries,
      },
    };
  }

  private _emit(evt: ViewerEvent): void {
    this.emit("viewer_event", evt);
  }

  private _uid(): string {
    return Math.random().toString(36).slice(2, 8);
  }

  private _ts(): string {
    return new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  setState(s: BotState): void {
    this._state = s;
    if (s !== "COOLDOWN") this._stats.cooldownRemaining = 0;
    this._emit({
      type: "state",
      data: { state: s, isPaused: this._isPaused },
    });
    this.broadcastStats();
  }

  setRunning(running: boolean): void {
    this._isRunning = running;
    if (running) {
      this._startTime = Date.now();
      this._uptimeInterval = setInterval(() => {
        this._stats.uptime++;
        this.broadcastStats();
      }, 1000);
    } else {
      if (this._uptimeInterval) {
        clearInterval(this._uptimeInterval);
        this._uptimeInterval = null;
      }
    }
  }

  setPaused(paused: boolean): void {
    this._isPaused = paused;
    this._emit({
      type: "state",
      data: { state: this._state, isPaused: paused },
    });
  }

  setStep(detail: string): void {
    this._stats.stepDetail = detail;
    this.broadcastStats();
  }

  updateStats(partial: Partial<ViewerStats>): void {
    Object.assign(this._stats, partial);
    this.broadcastStats();
  }

  broadcastStats(): void {
    this._emit({ type: "stats", data: { ...this._stats } });
  }

  pushLog(level: LogLevel, msg: string): void {
    const entry: ViewerLog = {
      id: this._uid(),
      time: this._ts(),
      level,
      msg,
    };
    this._logs.push(entry);
    if (this._logs.length > 600) this._logs = this._logs.slice(-400);
    this._emit({ type: "log", data: entry });
  }

  pushError(msg: string): void {
    const e = { msg, time: this._ts() };
    this._errors.push(e);
    if (this._errors.length > 100) this._errors = this._errors.slice(-50);
    this._emit({ type: "error_alert", data: e });
  }

  setQueries(queries: VisibleQuery[]): void {
    this._queries = queries;
    this._emit({ type: "queries", data: queries });
  }

  setTransactions(txs: ViewerTx[], total?: number): void {
    this._txs = txs;
    this._emit({
      type: "transactions",
      data: { transactions: txs, total: total ?? txs.length },
    });
  }

  setJudgeDetail(judge: JudgeDetail | null): void {
    this._lastJudge = judge;
    this._emit({ type: "judge_detail", data: judge });
  }

  streamStart(): void {
    this._stats.isStreaming = true;
    this._stats.thinkingText = "";
    this._stats.tokPerSec = 0;
    this._emit({ type: "stream_start", data: {} });
  }

  streamChunk(full: string, tps: number): void {
    this._stats.thinkingText = full;
    this._stats.tokPerSec = tps;
    this._emit({
      type: "think_chunk",
      data: { full, tps },
    });
  }

  streamEnd(thinkingText: string, answerText: string, tokPerSec: number): void {
    this._stats.isStreaming = false;
    this._stats.thinkingText = thinkingText;
    this._stats.answerText = answerText;
    this._stats.tokPerSec = tokPerSec;
    this._emit({
      type: "stream_end",
      data: { thinkingText, answerText, tokPerSec },
    });
    this.broadcastStats();
  }

  setConfig(cfg: Partial<ViewerConfig>): void {
    Object.assign(this._config, cfg);
    this._emit({ type: "config_update", data: { ...this._config } });
  }

  setCapability(
    capabilityRank: number,
    nodeTier: "challenger" | "capable",
    isDeadLocked = false,
  ): void {
    this._stats.capabilityRank = capabilityRank;
    this._stats.nodeTier = nodeTier;
    this._stats.isDeadLocked = isDeadLocked;
    this.broadcastStats();
  }

  setChallengeRoundsAvailable(count: number): void {
    this._stats.challengeRoundsAvailable = count;
    this.broadcastStats();
  }
}

const g = globalThis as typeof globalThis & { __viewerBus?: ViewerEventBus };
if (!g.__viewerBus) g.__viewerBus = new ViewerEventBus();

export const viewerBus: ViewerEventBus = g.__viewerBus;
