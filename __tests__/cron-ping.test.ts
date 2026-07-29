import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pingCronRoute,
  TOKEN_REFRESH_INTERVAL_MS,
  REEL_ATTACH_INTERVAL_MS,
} from "../lib/ops/cron-ping";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.up.railway.app");
});

describe("pingCronRoute", () => {
  it("token refresh runs daily", () => {
    expect(TOKEN_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("reel attach runs every 5 minutes", () => {
    expect(REEL_ATTACH_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("calls the refresh-tokens route with the CRON_SECRET bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "secret-abc");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await pingCronRoute("/api/cron/refresh-tokens", fetchMock);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openreply.up.railway.app/api/cron/refresh-tokens",
      { headers: { authorization: "Bearer secret-abc" } }
    );
  });

  it("calls the attach-next-reel route with the CRON_SECRET bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "secret-abc");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await pingCronRoute("/api/cron/attach-next-reel", fetchMock);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openreply.up.railway.app/api/cron/attach-next-reel",
      { headers: { authorization: "Bearer secret-abc" } }
    );
  });

  it("returns false without throwing when the route rejects", async () => {
    vi.stubEnv("CRON_SECRET", "wrong");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    expect(await pingCronRoute("/api/cron/refresh-tokens", fetchMock)).toBe(
      false
    );
  });

  it("returns false without throwing when the request errors", async () => {
    vi.stubEnv("CRON_SECRET", "secret-abc");
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await pingCronRoute("/api/cron/attach-next-reel", fetchMock)).toBe(
      false
    );
  });

  it("returns false when no secret is configured", async () => {
    const fetchMock = vi.fn();

    expect(await pingCronRoute("/api/cron/refresh-tokens", fetchMock)).toBe(
      false
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels log output per route so worker logs are distinguishable", async () => {
    vi.stubEnv("CRON_SECRET", "secret-abc");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pingCronRoute("/api/cron/attach-next-reel", fetchMock);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("attach-next-reel")
    );
    logSpy.mockRestore();
  });
});
