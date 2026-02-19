import { describe, it, expect } from "vitest";
import { secondsUntilDeadline, parseLastLetter, sleep } from "../src/utils.js";

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
});
