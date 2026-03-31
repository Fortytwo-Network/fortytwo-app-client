import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isNewerVersion } from "../src/update-check.js";

// Mock config module
vi.mock("../src/config.js", () => ({
  getConfigDir: () => "/tmp/test-fortytwo",
}));

// Mock fs to control cache behavior
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("no cache"); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("isNewerVersion", () => {
  it("detects newer major", () => {
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  });

  it("detects newer minor", () => {
    expect(isNewerVersion("0.2.0", "0.1.4")).toBe(true);
  });

  it("detects newer patch", () => {
    expect(isNewerVersion("0.1.5", "0.1.4")).toBe(true);
  });

  it("returns false for same version", () => {
    expect(isNewerVersion("0.1.4", "0.1.4")).toBe(false);
  });

  it("returns false for older version", () => {
    expect(isNewerVersion("0.1.3", "0.1.4")).toBe(false);
  });

  it("handles major difference correctly", () => {
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
  });
});

describe("checkForUpdate", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches latest version from registry", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ version: "99.0.0" }),
    }) as any;

    const { checkForUpdate } = await import("../src/update-check.js");
    const result = await checkForUpdate();

    expect(result).not.toBeNull();
    expect(result!.latestVersion).toBe("99.0.0");
    expect(result!.updateAvailable).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("registry.npmjs.org"),
      expect.any(Object),
    );
  });

  it("returns null on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error")) as any;

    const { checkForUpdate } = await import("../src/update-check.js");
    const result = await checkForUpdate();

    expect(result).toBeNull();
  });

  it("uses cache when fresh", async () => {
    const fs = await import("node:fs");
    const now = Date.now();
    (fs.readFileSync as any).mockReturnValue(
      JSON.stringify({ lastCheck: now, latestVersion: "0.2.0" }),
    );

    globalThis.fetch = vi.fn() as any;

    const { checkForUpdate } = await import("../src/update-check.js");
    const result = await checkForUpdate();

    expect(result).not.toBeNull();
    expect(result!.latestVersion).toBe("0.2.0");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("getCachedUpdate", () => {
  it("returns null when no cache exists", async () => {
    const fs = await import("node:fs");
    (fs.readFileSync as any).mockImplementation(() => { throw new Error("no file"); });

    const { getCachedUpdate } = await import("../src/update-check.js");
    const result = getCachedUpdate();

    expect(result).toBeNull();
  });
});
