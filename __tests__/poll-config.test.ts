import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPollIntervalMs,
  DEFAULT_POLL_INTERVAL_MS,
} from "../lib/ops/poll-config";

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("getPollIntervalMs", () => {
  it("defaults to 60s so Phase 1 polling is the primary trigger", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(60_000);
    expect(getPollIntervalMs()).toBe(60_000);
  });

  it("uses a valid configured value", () => {
    vi.stubEnv("COMMENT_POLL_INTERVAL_MS", "300000");
    expect(getPollIntervalMs()).toBe(300_000);
  });

  // The bug this module exists to prevent: Number("60s") is NaN, and
  // setInterval(fn, NaN) coerces to 0, which sweeps Instagram's API in a
  // tight loop.
  it("falls back to the default on a non-numeric value", () => {
    vi.stubEnv("COMMENT_POLL_INTERVAL_MS", "60s");
    expect(getPollIntervalMs()).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("falls back to the default on zero or negative values", () => {
    vi.stubEnv("COMMENT_POLL_INTERVAL_MS", "0");
    expect(getPollIntervalMs()).toBe(DEFAULT_POLL_INTERVAL_MS);
    vi.stubEnv("COMMENT_POLL_INTERVAL_MS", "-5000");
    expect(getPollIntervalMs()).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("clamps below a 10s floor to protect the API quota", () => {
    vi.stubEnv("COMMENT_POLL_INTERVAL_MS", "500");
    expect(getPollIntervalMs()).toBe(10_000);
  });
});
