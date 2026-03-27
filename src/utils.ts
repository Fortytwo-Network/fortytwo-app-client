import { COLORS, ROLE_OPTIONS } from "./constants.js";
import { viewerBus } from "./event-bus.js";

export { COLORS, ROLE_OPTIONS };

export function getRoleLabel(value: string, context: "onboard" | "bot" = "bot"): string {
  const opt = ROLE_OPTIONS.find((opt) => opt.value === value);
  if (!opt) return value;
  return context === "onboard" ? opt.label : opt.display;
}

// ── Number formatting ────────────────────────────────────────

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

export function formatNumber(value: number | string, digits?: number): string {
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

// ── Name truncation ──────────────────────────────────────────

export function truncateName(name: string, max = 33): string {
  if (name.length <= max) return name;
  return name.slice(0, max) + "...";
}

// ── Global log ────────────────────────────────────────────────
let _logFn: (msg: string) => void = console.log;

export function setLogFn(fn: (msg: string) => void): void {
  _logFn = fn;
}

export function log(msg: string): void {
  _logFn(msg);
  viewerBus.pushLog("info", msg);
}

// ── Verbose logging ───────────────────────────────────────────
let _verbose = false;

export function setVerbose(on: boolean): void {
  _verbose = on;
}

export function verbose(msg: string): void {
  if (_verbose) {
    _logFn(`[verbose] ${msg}`);
    viewerBus.pushLog("dim", msg);
  }
}

// ── Pinned tasks (shown as active tasks section) ─────────────
export interface PinnedTask {
  id: string;
  label: string;
  startedAt: number;
}

const _pinned = new Map<string, PinnedTask>();

export function pinTask(id: string, label: string): void {
  _pinned.set(id, { id, label, startedAt: Date.now() });
}

export function unpinTask(id: string): void {
  _pinned.delete(id);
}

export function getPinnedTasks(): PinnedTask[] {
  return [..._pinned.values()];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function secondsUntilDeadline(deadlineStr: string): number {
  try {
    const normalized = deadlineStr.replace("Z", "+00:00");
    const deadline = new Date(normalized);
    if (isNaN(deadline.getTime())) return 0;
    return (deadline.getTime() - Date.now()) / 1000;
  } catch {
    return 0;
  }
}

export function parseLastLetter(text: string, valid: Set<string>): string | null {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const upper = lines[i].toUpperCase();
    if (valid.has(upper)) return upper;
    for (const ch of valid) {
      if (upper.endsWith(ch)) return ch;
    }
  }
  return null;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit));
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };

  const workers = Array.from({ length: Math.min(size, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}
