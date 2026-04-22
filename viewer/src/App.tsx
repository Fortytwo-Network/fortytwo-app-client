import { useState, useEffect, useRef, useCallback } from "react";

type LogLevel = "info" | "success" | "warn" | "error" | "dim" | "api";
interface Log { id: string; time: string; level: LogLevel; msg: string }
interface Tx { id: string; amount: string; transaction_type: string; description: string; created_at: string }
interface JudgeDetail {
  challengeId: string; questionText: string;
  answers: { id: string; content: string; agentId?: string }[];
  comparisons: { a: string; b: string; winner: string }[];
  finalRankings: string[]; goodAnswers: string[];
  phase: string; currentPairA: string | null; currentPairB: string | null;
  comparisonIndex: number; totalComparisons: number; scores: Record<string, number>;
}
interface VQ {
  id: string; specialization: string; stake: number; minRank: number;
  answerCount: number; status: string; questionText?: string; errorMsg?: string;
}
interface Stats {
  answers: number; judgments: number; energy: number; staked: number; total: number;
  weekEarned: number; lifetimeEarned: number; lifetimeSpent: number;
  cycles: number; uptime: number; rank: string; judgeElo: string; accuracy: string;
  wins: number; matches: number;
  activeQueryId: string | null; activeQuestionText: string | null; activeQuestionCat: string | null;
  questionsAvailable: number; cooldownRemaining: number;
  thinkingText: string; answerText: string; isStreaming: boolean; tokPerSec: number;
  stepDetail: string; accountInactive: boolean;
  answersSubmitted: number; answersWon: number; answerWinRate: string;
  judgmentsMade: number; judgmentAccuracy: string;
  queriesSubmitted: number; queriesCompleted: number;
  likesGiven: number; likesReceived: number;
  forBalance: string; intelligenceNormalized: string; judgingNormalized: string;
  capabilityRank: number | null; nodeTier: "challenger" | "capable" | null;
  capabilityWins: number; capabilityLosses: number;
  challengeRoundsAvailable: number;
}
interface Config {
  agentId: string; modelName: string; inferenceType: string;
  provider: string; cycleIntervalMs: number; autoRestart: boolean;
}

const PIPE_STATES = ["IDLE", "AUTHENTICATING", "SCANNING", "JOINING", "THINKING", "SUBMITTING", "JUDGING", "COOLDOWN"];

const PHASE_LABELS: Record<string, string> = {
  loading: "Loading challenge...",
  reading_answers: "Reading answers...",
  comparing: "Comparing answers...",
  ranking_all: "Ranking all answers...",
  submitting: "Submitting judgment...",
  done: "Judgment complete",
};

const LOG_COLORS: Record<string, string> = {
  info: "text-white/60", success: "text-white/60", warn: "text-white/60",
  error: "text-white/60", dim: "text-white/60", api: "text-white/60",
};

const LOG_FILTER = ["No challenges", "200", "No transactions", "No errors", "detail"];

const LOG_ICON_COLORS: Record<string, string> = {
  info: "rgba(255,255,255,0.6)", success: "rgba(255,255,255,0.6)", warn: "rgba(255,255,255,0.6)",
  error: "rgba(255,255,255,0.6)", dim: "rgba(255,255,255,0.6)", api: "rgba(255,255,255,0.6)",
};

function renderLogMsg(msg: string, level: string) {
  if (!msg.includes("FOR")) return msg;
  const color = LOG_ICON_COLORS[level] || "rgba(255,255,255,0.6)";
  const parts = msg.split(/\bFOR\b/);
  return parts.map((part, i) => (
    <span key={i}>
      {i > 0 && <span className="inline-flex align-middle" style={{ marginBottom: 1 }}><ForIcon size={12} color={color} /></span>}
      {part}
    </span>
  ));
}

function truncateDecimals(value: number, decimals: number): string {
  if (decimals <= 0) return String(Math.floor(value));
  const str = value.toFixed(20);
  const dotIdx = str.indexOf('.');
  const intPart = str.slice(0, dotIdx);
  const decPart = str.slice(dotIdx + 1, dotIdx + 1 + decimals).padEnd(decimals, '0');
  return `${intPart}.${decPart}`;
}

function stripTrailingZeros(str: string): string {
  if (!str.includes('.')) return str;
  return str.replace(/\.?0+$/, '');
}

function formatNumber(value: number | string, digits?: number): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(num)) return '0';

  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);

  const withSuffix = (divisor: number, suffix: string): string => {
    const divided = abs / divisor;
    const intLen = Math.floor(divided).toString().length;
    const decimalPlaces = digits ?? Math.max(0, 4 - intLen);
    return `${sign}${stripTrailingZeros(truncateDecimals(divided, decimalPlaces))}${suffix}`;
  };

  if (abs >= 1_000_000_000) return withSuffix(1_000_000_000, 'B');
  if (abs >= 1_000_000) return withSuffix(1_000_000, 'M');
  if (abs >= 100_000) return withSuffix(1_000, 'K');

  if (abs >= 1_000) {
    const decimalPlaces = digits ?? 0;
    const truncated = truncateDecimals(abs, decimalPlaces);
    const stripped = stripTrailingZeros(truncated);
    const [intPart, decPart] = stripped.split('.');
    const intWithCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + (decPart ? `${intWithCommas}.${decPart}` : intWithCommas);
  }

  const intLen = Math.floor(abs).toString().length;
  const decimalPlaces = digits ?? (5 - intLen);
  return `${sign}${stripTrailingZeros(truncateDecimals(abs, decimalPlaces))}`;
}

function parseTxDesc(d: string): string {
  try {
    const p = JSON.parse(d);
    return p.label || p.type || "—";
  } catch {
    return d.substring(0, 60);
  }
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getQInfo(q: VQ): { color: string; label: string; dim: boolean; dotColor: string | null } {
  const s = q.status;
  if (s === "active") return { color: "text-white", label: "Answering", dim: false, dotColor: "#00DAF7" };
  if (s === "checking") return { color: "text-white/60", label: "Scanning...", dim: false, dotColor: "rgba(0,218,247,0.6)" };
  if (s === "answered" || s === "joined") return { color: "text-white/40", label: "Answered", dim: true, dotColor: "#0D0" };
  if (s === "skipped_rank") return {
    color: "text-white/40",
    label: `Rank too low${q.minRank ? ` (${q.minRank})` : q.errorMsg ? ` — ${q.errorMsg.substring(0, 30)}` : ""}`,
    dim: true,
    dotColor: "#7D7D7D",
  };
  if (s === "skipped_own") return { color: "text-white/40", label: "Your query", dim: true, dotColor: "#7D7D7D" };
  if (s === "error") return { color: "text-white/40", label: q.errorMsg?.substring(0, 30) || "Error", dim: true, dotColor: "#7D7D7D" };
  return { color: "text-white/40", label: "Available", dim: false, dotColor: null };
}

function Logo() {
  return (
    <svg width="35" height="17" viewBox="0 0 35 17" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="34.3711" y="0.223789" width="15.9495" height="6.8583" transform="rotate(90 34.3711 0.223789)" fill="white" />
      <rect x="25.2798" y="0.223293" width="15.9495" height="6.8583" transform="rotate(90 25.2798 0.223293)" fill="white" />
      <ellipse cx="3.66852" cy="3.66839" rx="3.66839" ry="3.66839" transform="rotate(-180 3.66852 3.66839)" fill="white" />
      <ellipse cx="3.66852" cy="12.7277" rx="3.66839" ry="3.66839" transform="rotate(-180 3.66852 12.7277)" fill="white" />
      <ellipse cx="12.7916" cy="3.66839" rx="3.66839" ry="3.66839" transform="rotate(-180 12.7916 3.66839)" fill="white" />
      <circle cx="12.7916" cy="12.7277" r="3.66839" transform="rotate(-180 12.7916 12.7277)" fill="white" />
    </svg>
  );
}

function ForIcon({ size = 16, color = "white" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_1935_14546)">
      <path fillRule="evenodd" clipRule="evenodd" d="M8.03348 0C12.6081 4.58965e-06 16 3.39665 16 8C16 12.6033 12.6081 16 8.03348 16C3.41424 16 2.18902e-07 12.6034 0 8C0 3.39665 3.41424 0 8.03348 0ZM5.67783 8.56994C4.64671 8.56994 3.81101 9.40564 3.81101 10.4368C3.81111 11.4678 4.64677 12.3036 5.67783 12.3036C6.7088 12.3035 7.54455 11.4677 7.54464 10.4368C7.54464 9.4057 6.70886 8.57004 5.67783 8.56994ZM10.3237 8.56994C9.29255 8.56994 8.45685 9.40564 8.45685 10.4368C8.45694 11.4678 9.29261 12.3036 10.3237 12.3036C11.3546 12.3035 12.1904 11.4677 12.1905 10.4368C12.1905 9.4057 11.3547 8.57004 10.3237 8.56994ZM5.67783 3.95536C4.64671 3.95536 3.81101 4.79106 3.81101 5.82217C3.81111 6.8532 4.64677 7.68899 5.67783 7.68899C6.7088 7.68889 7.54455 6.85314 7.54464 5.82217C7.54464 4.79112 6.70886 3.95545 5.67783 3.95536ZM10.3237 3.95536C9.29255 3.95536 8.45685 4.79106 8.45685 5.82217C8.45694 6.8532 9.29261 7.68899 10.3237 7.68899C11.3546 7.68889 12.1904 6.85314 12.1905 5.82217C12.1905 4.79112 11.3547 3.95545 10.3237 3.95536Z" fill={color}/>
      </g>
      <defs>
      <clipPath id="clip0_1935_14546">
      <rect width={size} height={size} fill={color}/>
      </clipPath>
      </defs>
    </svg>
  );
}

export default function AgenticVision() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState("IDLE");
  const [stats, setStats] = useState<Stats>({
    answers: 0, judgments: 0, energy: 0, staked: 0, total: 0,
    weekEarned: 0, lifetimeEarned: 0, lifetimeSpent: 0,
    cycles: 0, uptime: 0, rank: "—", judgeElo: "—", accuracy: "—",
    wins: 0, matches: 0,
    activeQueryId: null, activeQuestionText: null, activeQuestionCat: null,
    questionsAvailable: 0, cooldownRemaining: 0,
    thinkingText: "", answerText: "", isStreaming: false, tokPerSec: 0,
    stepDetail: "", accountInactive: false,
    answersSubmitted: 0, answersWon: 0, answerWinRate: "0",
    judgmentsMade: 0, judgmentAccuracy: "0",
    queriesSubmitted: 0, queriesCompleted: 0,
    likesGiven: 0, likesReceived: 0,
    forBalance: "0", intelligenceNormalized: "0", judgingNormalized: "0",
    capabilityRank: null, nodeTier: null,
    capabilityWins: 0, capabilityLosses: 0,
    challengeRoundsAvailable: 0,
  });
  const [logs, setLogs] = useState<Log[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [errors, setErrors] = useState<{ msg: string; time: string }[]>([]);
  const [queries, setQueries] = useState<VQ[]>([]);
  const [judge, setJudge] = useState<JudgeDetail | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [rTab, setRTab] = useState<"log" | "txs" | "errors">("log");

  const [streamText, setStreamText] = useState("");
  const [streamTps, setStreamTps] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamAnswer, setStreamAnswer] = useState("");
  const [botThinking, setBotThinking] = useState(false);

  const [justSubmitted, setJustSubmitted] = useState(false);
  const [submittedQueryId, setSubmittedQueryId] = useState<string | null>(null);
  const activeQueryRef = useRef<string | null>(null);
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const thinkRef = useRef<HTMLDivElement>(null);
  const challengeRoundBase = useRef({ answers: 0, wins: 0, active: false });
  const [challengeRoundStats, setChallengeRoundStats] = useState<{
    answers: number;
    wins: number;
    rate: number;
  } | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource("/api/stream");

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          switch (ev.type) {
            case "init":
              setState(ev.data.state || "IDLE");
              setStats(ev.data.stats || {});
              setLogs(ev.data.logs || []);
              setConfig(ev.data.config || null);
              setTxs(ev.data.transactions || []);
              setErrors(ev.data.errors || []);
              setQueries(ev.data.queries || []);
              if (ev.data.lastJudge) setJudge(ev.data.lastJudge);
              if (ev.data.stats?.isStreaming) {
                setIsStreaming(true);
                setStreamText(ev.data.stats.thinkingText || "");
                setStreamTps(ev.data.stats.tokPerSec || 0);
              }
              activeQueryRef.current = ev.data.stats?.activeQueryId || null;
              break;
            case "state":
              setState(ev.data.state);
              break;
            case "stats":
              setStats((prev) => {
                const next = { ...prev, ...ev.data };
                const nextId = next.activeQueryId || null;
                if (activeQueryRef.current && !nextId) {
                  setSubmittedQueryId(activeQueryRef.current);
                  setJustSubmitted(true);
                  setBotThinking(false);
                  if (submitTimer.current) clearTimeout(submitTimer.current);
                  submitTimer.current = setTimeout(() => {
                    setJustSubmitted(false);
                    setSubmittedQueryId(null);
                  }, 3000);
                }
                if (activeQueryRef.current && nextId && nextId !== activeQueryRef.current) {
                  setStreamText("");
                  setStreamAnswer("");
                  setIsStreaming(false);
                  setBotThinking(false);
                }
                activeQueryRef.current = nextId;
                return next;
              });
              break;
            case "log":
              setLogs((prev) => {
                const next = [...prev, ev.data];
                return next.length > 400 ? next.slice(-300) : next;
              });
              break;
            case "error_alert":
              setErrors((prev) => [...prev.slice(-49), ev.data]);
              break;
            case "config_update":
              setConfig(ev.data);
              break;
            case "queries":
              setQueries(ev.data);
              if (!ev.data || ev.data.length === 0) {
                setJustSubmitted(false);
                setSubmittedQueryId(null);
                activeQueryRef.current = null;
                if (submitTimer.current) clearTimeout(submitTimer.current);
              }
              break;
            case "transactions":
              setTxs(ev.data.transactions || []);
              setTxTotal(ev.data.total || 0);
              break;
            case "judge_detail":
              setJudge(ev.data);
              break;
            case "stream_start":
              setBotThinking(true);
              setIsStreaming(true);
              setStreamText("");
              setStreamTps(0);
              setStreamAnswer("");
              setJustSubmitted(false);
              setSubmittedQueryId(null);
              break;
            case "think_chunk":
              setBotThinking(false);
              setStreamText(ev.data.full || "");
              setStreamTps(ev.data.tps || 0);
              setIsStreaming(true);
              break;
            case "stream_end":
              setIsStreaming(false);
              setBotThinking(false);
              setStreamText(ev.data.thinkingText || "");
              setStreamTps(ev.data.tokPerSec || 0);
              setStreamAnswer(ev.data.answerText || "");
              break;
          }
        } catch {}
      };

      es.onerror = () => {
        setConnected(false);
        es?.close();
        retryTimer = setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      es?.close();
      clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs, txs, errors, rTab]);

  useEffect(() => {
    thinkRef.current?.scrollTo({ top: thinkRef.current.scrollHeight });
  }, [streamText]);

  useEffect(() => {
    const challengeActive = (stats.challengeRoundsAvailable || 0) > 0;
    const baseline = challengeRoundBase.current;

    if (challengeActive && !baseline.active) {
      challengeRoundBase.current = {
        active: true,
        answers: stats.answersSubmitted || 0,
        wins: stats.answersWon || 0,
      };
      setChallengeRoundStats({ answers: 0, wins: 0, rate: 0 });
      return;
    }

    if (!challengeActive && baseline.active) {
      challengeRoundBase.current = { answers: 0, wins: 0, active: false };
      setChallengeRoundStats(null);
      return;
    }

    if (challengeActive && baseline.active) {
      const answers = Math.max(0, (stats.answersSubmitted || 0) - baseline.answers);
      const wins = Math.max(0, (stats.answersWon || 0) - baseline.wins);
      setChallengeRoundStats({
        answers,
        wins,
        rate: answers > 0 ? Math.round((wins / answers) * 100) : 0,
      });
    }
  }, [stats.challengeRoundsAvailable, stats.answersSubmitted, stats.answersWon]);

  const activeQuery = queries.find((q) => q.status === "active");
  const winRate = stats.answersSubmitted > 0
    ? ((stats.answersWon / stats.answersSubmitted) * 100).toFixed(1)
    : stats.answerWinRate || "0";
  const challengeAnswersTotal = (stats.capabilityWins || 0) + (stats.capabilityLosses || 0);
  const challengeWinRate = challengeAnswersTotal > 0
    ? Math.round((stats.capabilityWins / challengeAnswersTotal) * 100)
    : 0;

  const isCooldown = state === "COOLDOWN";
  const isJudging = state === "JUDGING";
  const isThinkingWait = (state === "THINKING" || botThinking) && !streamText && !streamAnswer;
  const hasActiveQuestion = !!stats.activeQuestionText;

  const renderJudge = useCallback((j: JudgeDetail) => {
    const phase = j.phase || "loading";
    const isComparing = phase === "comparing" && j.currentPairA && j.currentPairB;
    const isDone = phase === "done" || phase === "submitting";
    const maxScore = Math.max(1, ...Object.values(j.scores || {}));
    const goodPercent = j.answers.length > 0 ? Math.round((j.goodAnswers.length / j.answers.length) * 100) : 0;
    const goodColor = goodPercent >= 50 ? "text-ft-green" : "text-red-500";

    return (
      <div className="flex flex-col gap-6 p-6 overflow-auto h-full">
        <div className="flex items-center gap-4">
          <span className="text-[15px] text-white tracking-[0.15px]">Judging</span>
          <span className="text-[15px] text-white/40 tracking-[0.15px]">{j.challengeId.slice(0, 12)}</span>
          <span className="ml-auto text-[15px] text-white/40 tracking-[0.15px]">
            {PHASE_LABELS[phase] || phase}
          </span>
        </div>

        {phase === "comparing" && j.totalComparisons > 0 && (
          <div>
            <div className="flex justify-between mb-2">
              <span className="text-[15px] text-white/40 tracking-[0.15px]">Comparisons</span>
              <span className="text-[15px] text-white tracking-[0.15px]">
                {j.comparisonIndex}/{j.totalComparisons}
              </span>
            </div>
            <div className="h-[2px] bg-white/10 w-full">
              <div
                className="h-[2px] bg-ft-blue transition-all duration-500 ease-out"
                style={{ width: `${(j.comparisonIndex / j.totalComparisons) * 100}%` }}
              />
            </div>
          </div>
        )}

        <div>
          <div className="text-[15px] text-white/40 tracking-[0.15px] mb-2">Question</div>
          <p className="text-[15px] text-white tracking-[0.15px] leading-6">
            {j.questionText.substring(0, 500)}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <span className="text-[15px] text-white/40 tracking-[0.15px]">
            Answers ({j.answers.length})
          </span>
          {j.answers.map((a) => {
            const isInPair = j.currentPairA === a.id || j.currentPairB === a.id;
            const pairLabel = j.currentPairA === a.id ? "A" : j.currentPairB === a.id ? "B" : null;
            const rk = j.finalRankings.indexOf(a.id);
            const good = j.goodAnswers.includes(a.id);
            const score = j.scores?.[a.id] || 0;
            const barW = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

            return (
              <div
                key={a.id}
                className="flex flex-col gap-2 transition-colors duration-200 relative"
              >
                {rk === 0 && <div className="absolute -left-3 top-0 bottom-0 w-[2px] bg-[#F700CE]" />}
                <div className="flex items-center gap-3 flex-wrap">
                  {!isDone && isInPair && pairLabel && (
                    <span className="text-[15px] font-semibold text-ft-blue w-6 h-6 flex items-center justify-center">
                      {pairLabel}
                    </span>
                  )}
                  <span className={`text-[15px] tracking-[0.15px] ${isInPair ? "text-white" : "text-white/60"}`}>
                    {a.id.slice(0, 10)}
                  </span>
                  {a.agentId && (
                    <span className="text-[15px] text-white/40 tracking-[0.15px]">
                      Node:{a.agentId.slice(0, 8)}
                    </span>
                  )}
                  {good && (
                    <span className={`text-[13px] ${goodColor} px-1.5 py-px`}>
                      {goodPercent}% GOOD
                    </span>
                  )}
                </div>
                <p className={`text-[15px] tracking-[0.15px] leading-6 whitespace-pre-wrap overflow-hidden transition-[max-height] duration-300 ${
                  isDone ? "text-white max-h-[400px]" : isInPair ? "text-white/60 max-h-[400px]" : "text-white/30 max-h-[80px]"
                }`}>
                  {a.content}
                </p>
              </div>
            );
          })}
        </div>

        {(streamText || isStreaming) && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4">
              <span className="text-[15px] text-white tracking-[0.15px]">
                {isComparing
                  ? `Comparing ${j.currentPairA?.slice(0, 6)} vs ${j.currentPairB?.slice(0, 6)}`
                  : phase === "ranking_all" ? "Ranking all answers" : "Reasoning"}
              </span>
              {isStreaming && <span className="w-1 h-1 rounded-full bg-ft-cyan animate-ft-pulse" />}
              {isStreaming && <span className="text-[15px] text-white/40 tracking-[0.15px]">{formatNumber(streamTps, 1)} tok/s</span>}
            </div>
            <div ref={thinkRef} className="max-h-[240px] overflow-y-auto">
              <p className="text-[15px] text-white tracking-[0.15px] leading-6 whitespace-pre-wrap">
                {streamText}
                {isStreaming && <span className="inline-block w-2 h-[14px] bg-ft-blue ml-0.5 animate-ft-blink" />}
              </p>
            </div>
          </div>
        )}

        {j.comparisons.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[15px] text-white/40 tracking-[0.15px]">
              Comparisons ({j.comparisons.length}{j.totalComparisons > 0 ? `/${j.totalComparisons}` : ""})
            </span>
            {j.comparisons.map((c, i) => (
              <div key={i} className="flex items-center gap-4 text-[15px] tracking-[0.15px]">
                <span className="text-white/30 tabular-nums min-w-[20px]">#{i + 1}</span>
                <span className={c.winner === "A" ? "text-white font-semibold" : "text-white/40"}>
                  {c.a.slice(0, 8)}
                </span>
                <span className="text-white/30">vs</span>
                <span className={c.winner === "B" ? "text-white font-semibold" : "text-white/40"}>
                  {c.b.slice(0, 8)}
                </span>
              </div>
            ))}
          </div>
        )}

        {j.finalRankings.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className={`text-[15px] tracking-[0.15px] ${isDone ? "text-white" : "text-white/40"}`}>
              Final Ranking {isDone ? "✓" : ""}
            </span>
            {j.finalRankings.map((id, i) => (
              <div
                key={id}
                className="flex items-center gap-4 text-[15px] tracking-[0.15px] py-1"
              >
                <span className={`font-semibold min-w-[30px] ${i === 0 ? "text-white" : "text-white/40"}`}>
                  #{i + 1}
                </span>
                <span className="text-white/60">{id.slice(0, 12)}</span>
                {(j.scores?.[id] || 0) > 0 && (
                  <span className="text-white/40">{j.scores[id]} wins</span>
                )}
                {j.goodAnswers.includes(id) && (
                  <span className={`text-[13px] ${goodColor} px-1.5 py-px`}>
                    {goodPercent}% GOOD
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }, [streamText, isStreaming, streamTps]);

  return (
    <div className="h-screen w-screen bg-black flex flex-col overflow-hidden">
      {!connected && (
        <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center">
          <div className="text-center">
            <div className="text-white/40 text-[15px] mb-2">Node disconnected</div>
            <div className="text-white/20 text-[14px] animate-ft-pulse">Reconnecting...</div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-10 px-8 pt-7 pb-6 shrink-0">
        <div className="flex items-center gap-[7px]">
          <Logo />
          <span className="text-[20px] font-semibold tracking-[0.2px]">Node Vision</span>
        </div>
        <div className="flex items-center gap-6 text-[15px] tracking-[0.15px]">
          <span className="text-white">{state === "IDLE" ? "Idle" : state.charAt(0) + state.slice(1).toLowerCase()}</span>
          <span className="text-white/40">{stats.questionsAvailable || queries.length} Questions</span>
          <span className="text-white/40">{queries.filter((q) => q.status === "available").length} Available</span>
          {stats.stepDetail && (
            <span className="text-white/30 truncate max-w-[200px]">{stats.stepDetail}</span>
          )}
          {challengeRoundStats && (
            <span className="text-ft-blue max-w-[420px] truncate">
              A {formatNumber(challengeRoundStats.answers)} won {formatNumber(challengeRoundStats.wins)} rate {challengeRoundStats.rate}% /current challenge only
            </span>
          )}
          {isStreaming ? (
            <span className="text-white/40 animate-ft-pulse">Generating response...</span>
          ) : botThinking ? (
            <span className="text-white/40 animate-ft-pulse">Thinking...</span>
          ) : justSubmitted ? (
            <span className="text-white/40">Submitted ✓</span>
          ) : null}
          {stats.accountInactive && (
            <span className="text-ft-orange animate-ft-pulse">Account inactive</span>
          )}
          {errors.length > 0 && (
            <span
              onClick={() => setRTab("errors")}
              className="cursor-pointer bg-red-500 text-white text-[12px] px-1.5 py-0.5 min-w-[20px] text-center"
            >
              {errors.length}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 px-8 gap-8 overflow-hidden">
        <div className="w-[304px] shrink-0 flex flex-col gap-6 overflow-y-auto">
          <div className="flex gap-1">
            <a
              href="https://app.fortytwo.network/queries/create"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 bg-ft-blue p-3 flex flex-col gap-4 hover:opacity-90 transition-opacity"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5V14.5M1.5 8H14.5" stroke="white" strokeWidth="1.5" />
              </svg>
              <span className="text-[15px] text-white tracking-[0.15px]">Ask the Swarm</span>
            </a>
            <a
              href={config?.agentId ? `https://app.fortytwo.network/agents/${config.agentId}` : "https://app.fortytwo.network"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 bg-white/[0.07] p-3 flex flex-col gap-4 hover:opacity-90 transition-opacity"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="5" r="3" stroke="white" strokeWidth="1.2" fill="none" />
                <path d="M2.5 14C2.5 11 5 9 8 9C11 9 13.5 11 13.5 14" stroke="white" strokeWidth="1.2" fill="none" />
              </svg>
              <span className="text-[15px] text-white tracking-[0.15px]">Account</span>
            </a>
          </div>

          <div className="px-3 flex flex-col gap-6">
            <div className="flex gap-3">
              <div className="flex-1 flex flex-col gap-2 pr-1">
                <span className="text-[15px] text-white tracking-[0.15px]">Answers Total</span>
                <span className="text-[17px] text-white tracking-[0.17px]">{formatNumber(stats.answersSubmitted || 0)}</span>
                <div className="text-[14px] text-white/60 tracking-[0.14px] leading-5">
                  {formatNumber(stats.answersWon || 0)} wins<br />{winRate}% win rate
                </div>
              </div>
              <div className="flex-1 flex flex-col gap-2 pl-4 pr-1 border-l border-white/10">
                <span className="text-[15px] text-white tracking-[0.15px]">Judgments</span>
                <span className="text-[17px] text-white tracking-[0.17px]">{formatNumber(stats.judgmentsMade || 0)}</span>
                <div className="text-[14px] text-white/60 tracking-[0.14px] leading-5">
                  {formatNumber(stats.accuracy || 0)}% accuracy
                </div>
              </div>
            </div>
            <div className="pt-1 flex flex-col gap-2">
              <span className="text-[15px] text-white tracking-[0.15px]">Challenge Answers</span>
              <span className="text-[17px] text-white tracking-[0.17px]">{formatNumber(challengeAnswersTotal)}</span>
              <div className="text-[14px] text-white/60 tracking-[0.14px] leading-5">
                {formatNumber(stats.capabilityWins || 0)} wins<br />{challengeWinRate}% win rate
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <span className="text-[17px] text-white tracking-[0.17px]">Economy</span>
              <div className="flex gap-3">
                <div className="flex-1 flex flex-col gap-2 pr-1">
                  <div className="flex items-center gap-2">
                    <ForIcon />
                    <span className="text-[15px] text-white tracking-[0.15px]">{formatNumber(stats.energy)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ForIcon />
                    <span className="text-[15px] text-white tracking-[0.15px]">{formatNumber(stats.staked)} Staked</span>
                  </div>
                </div>
                <div className="flex-1 flex flex-col gap-2 pl-4 pr-1 border-l border-white/10">
                  <div className="flex items-center gap-2">
                    <ForIcon />
                    <span className="text-[15px] tracking-[0.15px] flex gap-1">
                      <span className="text-ft-green">+{formatNumber(stats.weekEarned)}</span>
                      <span className="text-white/60 whitespace-nowrap"> / Day</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ForIcon />
                    <span className="text-[15px] tracking-[0.15px] flex gap-1">
                      <span className="text-white">-{formatNumber(stats.lifetimeSpent)}</span>
                      <span className="text-white/60 whitespace-nowrap"> / Week</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <span className="text-[17px] text-white tracking-[0.17px]">Current State</span>
              <div className="flex flex-col gap-2">
                {PIPE_STATES.map((s) => {
                  const isActive = state === s;
                  return (
                    <div key={s} className="flex items-center gap-0">
                      {isActive && <span className="w-1 h-1 rounded-full bg-white mr-2 -ml-3" />}
                      <span className={`text-[15px] tracking-[0.15px] ${isActive ? "text-white" : "text-white/40"}`}>
                        {s.charAt(0) + s.slice(1).toLowerCase()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <span className="text-[17px] text-white tracking-[0.17px]">Rank ELO / Normalized</span>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-[15px] tracking-[0.15px]">
                  <span className="text-white/40">Intelligence</span>
                  <span className="text-white/60">{stats.rank || "—"} / {stats.intelligenceNormalized || "—"}</span>
                </div>
                <div className="flex justify-between text-[15px] tracking-[0.15px]">
                  <span className="text-white/40">Judgment</span>
                  <span className="text-white/60">{stats.judgeElo || "—"} / {stats.judgingNormalized || "—"}</span>
                </div>
                {stats.nodeTier === "capable" && stats.capabilityRank !== null && (
                  <>
                    <div className="flex justify-between text-[15px] tracking-[0.15px]">
                      <span className="text-white/40">Capability</span>
                      <span className="text-white/60">{stats.capabilityRank} / 42</span>
                    </div>
                    {(stats.capabilityWins + stats.capabilityLosses) > 0 && (
                      <div className="flex justify-between text-[15px] tracking-[0.15px]">
                        <span className="text-white/40">Capability win rate</span>
                        <span className="text-white/60">
                          {Math.round(
                            (stats.capabilityWins /
                              (stats.capabilityWins + stats.capabilityLosses)) *
                              100,
                          )}
                          % ({stats.capabilityWins}/{stats.capabilityWins + stats.capabilityLosses})
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
          {isCooldown && (
            <div className="absolute inset-0 z-20 bg-black flex flex-col items-center justify-center">
              <div className="relative">
                <div className="text-[72px] font-bold text-white tabular-nums">
                  {stats.cooldownRemaining}
                </div>
                <div
                  className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-ft-blue/30 to-transparent"
                  style={{ animation: "cooldown-scan 2s linear infinite", top: "0%" }}
                />
              </div>
              <div className="text-[15px] text-white/40 tracking-[2px] mt-2">COOLDOWN</div>
              {stats.stepDetail && (
                <div className="text-[15px] text-white/30 tracking-[0.15px] mt-3">{stats.stepDetail}</div>
              )}
            </div>
          )}

          {isJudging && judge && !isCooldown && (
            <div className="absolute inset-0 z-10 bg-black overflow-auto">
              {renderJudge(judge)}
            </div>
          )}

          <div className={`flex-1 overflow-y-auto flex flex-col gap-6 ${
            isCooldown || (isJudging && judge) ? "invisible" : ""
          }`}>
            {connected && !isCooldown && !isJudging && queries.length === 0 && !hasActiveQuestion && state !== "IDLE" && (
              <div className="flex-1 flex flex-col items-center justify-center py-20">
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className="thinking-spinner w-5 h-5 border-2 border-white/10"
                    style={{ borderTopColor: "var(--tw-ft-blue, #2D2DFF)" }}
                  />
                  <span className="text-[15px] text-white tracking-[2px]">
                    {state}
                  </span>
                </div>
                <div className="text-[15px] text-white/40 tracking-[0.15px]">
                  {stats.stepDetail || "Working..."}
                </div>
              </div>
            )}

            {queries.length > 0 && (
              <div className="flex flex-col">
                {queries.map((q) => {
                  const info = getQInfo(q);
                  const isActive = stats.activeQueryId === q.id;
                  const isChecking = q.status === "checking";
                  const wasJustSubmitted = submittedQueryId === q.id && justSubmitted;
                  const questionText = q.questionText || (isActive ? stats.activeQuestionText : null);

                  return (
                    <div key={q.id}>
                      <div className="py-2.5 px-4 flex items-center gap-3 transition-all duration-200">
                        <span className={`text-[15px] tracking-[0.15px] ${
                          isActive ? "text-white"
                            : isChecking ? "text-white/60"
                            : wasJustSubmitted ? "text-white"
                            : "text-white/60"
                        }`}>
                          {q.specialization}
                        </span>
                        <div className="ml-auto flex items-center gap-6">
                          <div className="flex items-center gap-2">
                            {info.dotColor && (
                              <div
                                className={`w-1 h-1 rounded-full shrink-0 ${isActive || isChecking ? "animate-ft-pulse" : ""}`}
                                style={{ backgroundColor: info.dotColor }}
                              />
                            )}
                            <span className={`text-[15px] tracking-[0.15px] ${
                              isActive ? "text-white"
                                : isChecking ? "text-white/60"
                                : wasJustSubmitted ? "text-white"
                                : "text-white/40"
                            }`}>
                              {isActive ? "Answering"
                                : isChecking ? "Scanning..."
                                : wasJustSubmitted ? "Submitted ✓"
                                : info.label}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            <ForIcon color="rgba(255,255,255,0.4)" />
                            <span className="text-[15px] text-white/40 tracking-[0.15px]">{formatNumber(q.stake)}</span>
                          </div>

                          <span className="text-[15px] text-white/40 tracking-[0.15px]">{q.answerCount}/10</span>
                        </div>
                      </div>

                      {isActive && (
                        <div className="overflow-hidden">
                          {questionText && (
                            <div className="px-5 py-4">
                              <p className="text-[15px] text-white tracking-[0.15px] leading-6">
                                {questionText}
                              </p>
                            </div>
                          )}

                          {isThinkingWait && !streamAnswer && (
                            <div className="px-5 py-6">
                              <div>
                                <div className="text-[15px] text-white tracking-[0.15px] mb-1">Node is thinking...</div>
                                <div className="text-[14px] text-white/40 tracking-[0.14px]">
                                  Preparing {config?.modelName || "LLM"} response
                                </div>
                              </div>
                              <div className="flex flex-col gap-2.5">
                                {[85, 72, 90, 60].map((w, i) => (
                                  <div
                                    key={i}
                                    className="shimmer-line h-2 bg-white/5 overflow-hidden"
                                    style={{ width: `${w}%`, animationDelay: `${i * 0.1}s` }}
                                  >
                                    <div
                                      className="shimmer-slide h-full w-[40%] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent"
                                      style={{ animationDelay: `${i * 0.15}s` }}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {streamAnswer && !isStreaming && (
                            <div className="px-5 py-4">
                              <div className="text-[15px] text-white tracking-[0.15px] mb-2">
                                Answer
                              </div>
                              <div className="max-h-[200px] overflow-auto">
                                <p className="text-[15px] text-white/60 tracking-[0.15px] leading-6 whitespace-pre-wrap">
                                  {streamAnswer.substring(0, 2000)}
                                </p>
                              </div>
                            </div>
                          )}

                          {(isStreaming || streamText) && !isThinkingWait && (
                            <div className="px-5 py-4">
                              <div className="flex items-center gap-4 mb-3">
                                <div className="flex items-center gap-2">
                                  <span className={`w-1 h-1 rounded-full ${isStreaming ? "bg-ft-cyan animate-ft-pulse" : "bg-white/40"}`} />
                                  <span className="text-[15px] text-white tracking-[0.15px]">Reasoning</span>
                                </div>
                                {isStreaming && <span className="text-[15px] text-white/40 tracking-[0.15px]">{formatNumber(streamTps, 1)} tok/s</span>}
                              </div>
                              <div ref={thinkRef} className="max-h-[240px] overflow-y-auto">
                                <p className="text-[15px] text-white tracking-[0.15px] leading-6 whitespace-pre-wrap">
                                  {streamText}
                                  {isStreaming && <span className="inline-block w-2 h-[14px] bg-ft-blue ml-0.5 animate-ft-blink" />}
                                </p>
                              </div>
                            </div>
                          )}

                          {!streamText && !isStreaming && !streamAnswer && !isThinkingWait && (
                            <div className="px-5 py-4">
                              <div className="flex items-center gap-2">
                                <div className="w-1.5 h-1.5 bg-ft-blue animate-ft-pulse" />
                                <span className="text-[15px] text-white/40 tracking-[0.15px]">
                                  {stats.stepDetail || "Processing..."}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="w-[304px] shrink-0 flex flex-col overflow-hidden">
          <div className="flex mb-2">
            {(["log", "txs", "errors"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setRTab(tab)}
                className={`flex-1 text-[15px] tracking-[0.15px] pb-2 border-b transition-colors relative ${
                  rTab === tab ? "text-white border-white/40" : "text-white/40 border-white/10"
                }`}
              >
                {tab === "log" ? "Log" : tab === "txs" ? "Txs" : "Errors"}
                {tab === "errors" && errors.length > 0 && (
                  <span className="absolute top-1 right-3 w-1.5 h-1.5 bg-red-500" />
                )}
              </button>
            ))}
          </div>

          <div ref={logRef} className="flex-1 overflow-y-auto flex flex-col gap-1.5 pt-4">
            {rTab === "log" && logs
              .filter((l) => !LOG_FILTER.some((f) => l.msg.includes(f)))
              .map((l) => (
              <div key={l.id} className="flex gap-3 items-start log-entry">
                <span className="text-[15px] text-white/40 tracking-[0.15px] shrink-0 w-[54px]">{l.time}</span>
                <span className={`text-[15px] ${LOG_COLORS[l.level] || "text-white/60"} tracking-[0.15px] leading-6 break-words`}>
                  {renderLogMsg(l.msg, l.level)}
                </span>
              </div>
            ))}
            {rTab === "txs" && (txs.length > 0 ? txs.map((t) => {
              const amt = parseFloat(t.amount);
              const pos = amt > 0;
              return (
              <div key={t.id} className="flex gap-3 items-start">
                <span className="text-[15px] text-white/40 tracking-[0.15px] shrink-0 w-[54px]">
                  {new Date(t.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
                <div className="flex flex-col">
                  <span className={`text-[15px] tracking-[0.15px] flex items-center gap-1 ${pos ? "text-ft-green" : "text-red-500"}`}>
                    <ForIcon size={14} color="rgb(255,255,255)" /> {pos ? "+" : ""}{formatNumber(t.amount)}
                  </span>
                  <span className="text-[14px] text-white/30 tracking-[0.14px]">{parseTxDesc(t.description)}</span>
                </div>
              </div>
              );
            }) : (
              <div className="text-[15px] text-white/30 tracking-[0.15px] text-center py-8">No transactions</div>
            ))}
            {rTab === "errors" && (errors.length > 0 ? errors.slice().reverse()
              .filter((e) => !e.msg.includes("detail"))
              .map((e, i) => (
              <div key={i} className="flex gap-3 items-start">
                <span className="text-[15px] text-white/40 tracking-[0.15px] shrink-0 w-[54px]">{e.time}</span>
                <span className="text-[15px] text-red-500 tracking-[0.15px] leading-6 break-words">{renderLogMsg(e.msg, "error")}</span>
              </div>
            )) : (
              <div className="text-[15px] text-white/30 tracking-[0.15px] text-center py-8">No errors</div>
            ))}
          </div>

          {rTab === "txs" && txTotal > 0 && (
            <div className="py-2 text-[14px] text-white/30 tracking-[0.14px] text-center border-t border-white/5">
              {txTotal.toLocaleString()} total
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between px-8 py-4 shrink-0 border-t border-white/[0.05]">
        <div className="flex items-center gap-2">
          <span className="text-[15px] text-white/40 tracking-[0.15px]">Co-defined with</span>
          <a href="https://x.com/novee_dev" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:opacity-80 transition-opacity">
            <img src="https://pbs.twimg.com/profile_images/2027267301771247616/sA1KJYo6_400x400.jpg" alt="Novee" className="w-5 h-5 rounded-full" />
            <span className="text-[15px] text-white tracking-[0.15px]">Novee</span>
          </a>
        </div>
        <div className="flex items-center gap-6 text-[15px] tracking-[0.15px]">
          <span className="text-white">{formatNumber(stats.tokPerSec || streamTps || 0, 1)} tok/s</span>
          <span className="text-white">{config?.provider || "—"}</span>
          <span className="text-white">{config?.modelName || "—"}</span>
          <span className="text-white/40">{fmtUptime(stats.uptime || 0)}</span>
        </div>
      </div>
    </div>
  );
}
