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
