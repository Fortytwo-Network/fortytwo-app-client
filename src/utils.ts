// ── Global log ────────────────────────────────────────────────
let _logFn: (msg: string) => void = console.log;

export function setLogFn(fn: (msg: string) => void): void {
  _logFn = fn;
}

export function log(msg: string): void {
  _logFn(msg);
}

// ── Verbose logging ───────────────────────────────────────────
let _verbose = false;

export function setVerbose(on: boolean): void {
  _verbose = on;
}

export function verbose(msg: string): void {
  if (_verbose) _logFn(`[verbose] ${msg}`);
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
