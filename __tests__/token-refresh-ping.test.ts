import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pingTokenRefresh,
  TOKEN_REFRESH_INTERVAL_MS,
} from "../lib/ops/token-refresh-ping";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.up.railway.app");
});

describe("pingTokenRefresh", () => {
  it("runs daily", () => {
    expect(TOKEN_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("calls the cron route with the CRON_SECRET bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "secret-abc");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await pingTokenRefresh(fetchMock);

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openreply.up.railway.app/api/cron/refresh-tokens",
      { headers: { authorization: "Bearer secret-abc" } }
    );
  });

  it("returns false without throwing when the route rejects", async () => {
    vi.stubEnv("CRON_SECRET", "wrong");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    expect(await pingTokenRefresh(fetchMock)).toBe(false);
  });

  it("returns false without throwing when the request errors", async () => {
    vi.stubEnv("CRON_SECRET", "secret-abc");
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await pingTokenRefresh(fetchMock)).toBe(false);
  });

  it("returns false when no secret is configured", async () => {
    const fetchMock = vi.fn();

    expect(await pingTokenRefresh(fetchMock)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
