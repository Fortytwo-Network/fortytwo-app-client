import { describe, it, expect, beforeEach } from "vitest";
import {
  secondsUntilDeadline,
  parseLastLetter,
  sleep,
  setLogFn,
  log,
  setVerbose,
  verbose,
  pinTask,
  unpinTask,
  getPinnedTasks,
  mapWithConcurrency,
  getRoleLabel,
  formatNumber,
  truncateName,
} from "../src/utils.js";

describe("secondsUntilDeadline", () => {
  it("returns positive seconds for a future deadline", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = secondsUntilDeadline(future);
    expect(result).toBeGreaterThan(55);
    expect(result).toBeLessThanOrEqual(60);
  });

  it("returns negative seconds for a past deadline", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = secondsUntilDeadline(past);
    expect(result).toBeLessThan(-55);
  });

  it("handles Z suffix", () => {
    const future = new Date(Date.now() + 30_000).toISOString().replace("+00:00", "Z");
    const result = secondsUntilDeadline(future);
    expect(result).toBeGreaterThan(25);
  });

  it("returns 0 for invalid string", () => {
    expect(secondsUntilDeadline("not-a-date")).toBe(0);
    expect(secondsUntilDeadline("")).toBe(0);
  });

  it("returns 0 on exception (non-string input)", () => {
    expect(secondsUntilDeadline(null as any)).toBe(0);
    expect(secondsUntilDeadline(undefined as any)).toBe(0);
  });
});

describe("parseLastLetter", () => {
  it("extracts a direct match from last line", () => {
    expect(parseLastLetter("some reasoning\nA", new Set(["A", "B", "U"]))).toBe("A");
    expect(parseLastLetter("some reasoning\nB", new Set(["A", "B", "U"]))).toBe("B");
    expect(parseLastLetter("some reasoning\nU", new Set(["A", "B", "U"]))).toBe("U");
  });

  it("extracts letter that ends the last line", () => {
    expect(parseLastLetter("Answer: A", new Set(["A", "B", "U"]))).toBe("A");
    expect(parseLastLetter("The best is B", new Set(["A", "B", "U"]))).toBe("B");
  });

  it("is case-insensitive", () => {
    expect(parseLastLetter("a", new Set(["A", "B"]))).toBe("A");
    expect(parseLastLetter("answer: b", new Set(["A", "B"]))).toBe("B");
  });

  it("returns null when no valid letter found", () => {
    expect(parseLastLetter("no letter here", new Set(["A", "B", "U"]))).toBeNull();
    expect(parseLastLetter("", new Set(["A", "B"]))).toBeNull();
  });

  it("handles multi-word values like GOOD/BAD", () => {
    expect(parseLastLetter("evaluation\nGOOD", new Set(["GOOD", "BAD"]))).toBe("GOOD");
    expect(parseLastLetter("the answer is BAD", new Set(["GOOD", "BAD"]))).toBe("BAD");
  });

  it("searches from bottom up", () => {
    expect(parseLastLetter("A\nB\nU", new Set(["A", "B", "U"]))).toBe("U");
  });
});

describe("sleep", () => {
  it("resolves after the given time", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("resolves immediately if signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves early when signal aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const start = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("log / setLogFn", () => {
  it("uses custom log function", () => {
    const msgs: string[] = [];
    setLogFn((m) => msgs.push(m));
    log("hello");
    expect(msgs).toEqual(["hello"]);
    setLogFn(console.log);
  });
});

describe("verbose / setVerbose", () => {
  it("logs when verbose is on", () => {
    const msgs: string[] = [];
    setLogFn((m) => msgs.push(m));
    setVerbose(true);
    verbose("detail");
    expect(msgs[0]).toContain("[verbose]");
    expect(msgs[0]).toContain("detail");
    setVerbose(false);
    setLogFn(console.log);
  });

  it("does not log when verbose is off", () => {
    const msgs: string[] = [];
    setLogFn((m) => msgs.push(m));
    setVerbose(false);
    verbose("hidden");
    expect(msgs).toEqual([]);
    setLogFn(console.log);
  });
});

describe("pinTask / unpinTask / getPinnedTasks", () => {
  beforeEach(() => {
    for (const t of getPinnedTasks()) unpinTask(t.id);
  });

  it("pins and retrieves tasks", () => {
    pinTask("t1", "Task 1");
    const tasks = getPinnedTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("t1");
    expect(tasks[0].label).toBe("Task 1");
    expect(tasks[0].startedAt).toBeGreaterThan(0);
  });

  it("unpins tasks", () => {
    pinTask("t1", "Task 1");
    unpinTask("t1");
    expect(getPinnedTasks()).toHaveLength(0);
  });
});

describe("mapWithConcurrency", () => {
  it("processes all items", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it("preserves order", async () => {
    const results = await mapWithConcurrency([3, 1, 2], 1, async (x) => x * 10);
    expect(results).toEqual([30, 10, 20]);
  });

  it("returns empty for empty input", async () => {
    const results = await mapWithConcurrency([], 5, async (x) => x);
    expect(results).toEqual([]);
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (x) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active--;
      return x;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toEqual([1, 2, 3, 4]);
  });

  it("handles limit of 0 or negative", async () => {
    const results = await mapWithConcurrency([1, 2], 0, async (x) => x);
    expect(results).toEqual([1, 2]);
  });
});

describe("getRoleLabel", () => {
  it("returns human-readable label for onboard context", () => {
    expect(getRoleLabel("ANSWERER_AND_JUDGE", "onboard")).toBe("ANSWERER & JUDGE — both");
    expect(getRoleLabel("JUDGE", "onboard")).toBe("JUDGE — only judge challenges");
    expect(getRoleLabel("ANSWERER", "onboard")).toBe("ANSWERER — only answer queries");
  });

  it("returns short display name for bot context", () => {
    expect(getRoleLabel("ANSWERER_AND_JUDGE", "bot")).toBe("ANSWERER & JUDGE");
    expect(getRoleLabel("JUDGE", "bot")).toBe("JUDGE");
    expect(getRoleLabel("ANSWERER", "bot")).toBe("ANSWERER");
  });

  it("defaults to bot context", () => {
    expect(getRoleLabel("JUDGE")).toBe("JUDGE");
  });

  it("returns identity if value not found", () => {
    expect(getRoleLabel("UNKNOWN")).toBe("UNKNOWN");
  });
});

describe("formatNumber", () => {
  it("formats small numbers correctly", () => {
    expect(formatNumber(123)).toBe("123");
    expect(formatNumber(123.45)).toBe("123.45");
    expect(formatNumber(123.45678, 2)).toBe("123.45");
  });

  it("adds commas for thousands", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(1234567)).toBe("1.234M");
  });

  it("uses suffixes for large numbers", () => {
    expect(formatNumber(1000000)).toBe("1M");
    expect(formatNumber(1500000)).toBe("1.5M");
    expect(formatNumber(1000000000)).toBe("1B");
  });

  it("handles negative numbers", () => {
    expect(formatNumber(-123.45)).toBe("-123.45");
    expect(formatNumber(-1000000)).toBe("-1M");
  });

  it("handles string input", () => {
    expect(formatNumber("123.45")).toBe("123.45");
  });

  it("returns '0' for invalid input", () => {
    expect(formatNumber("abc")).toBe("0");
  });
});

describe("truncateName", () => {
  it("does not truncate short names", () => {
    expect(truncateName("Short Name")).toBe("Short Name");
  });

  it("truncates long names", () => {
    expect(truncateName("This is a very long name that should be truncated", 10)).toBe("This is a ...");
  });

  it("uses default limit of 33", () => {
    const longName = "A".repeat(40);
    expect(truncateName(longName)).toBe("A".repeat(33) + "...");
  });
});
