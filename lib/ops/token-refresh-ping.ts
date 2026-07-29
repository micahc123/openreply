/**
 * Token refresh trigger.
 *
 * app/api/cron/refresh-tokens rotates Instagram long-lived tokens before they
 * expire (~60 days) and resets monthly usage counters. Upstream expects Vercel
 * Cron to call it; this deployment runs on Railway, so the always-on worker
 * triggers it instead.
 *
 * Never throws. A failed refresh ping must not take the worker down — the DM
 * queue matters more, and the route is idempotent, so the next tick retries.
 */

import { getBaseUrl } from "@/lib/env";

export const TOKEN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function pingTokenRefresh(
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const secret = process.env.CRON_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error("[token-refresh] No CRON_SECRET or NEXTAUTH_SECRET set");
    return false;
  }

  const url = `${getBaseUrl()}/api/cron/refresh-tokens`;

  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${secret}` },
    });

    if (!response.ok) {
      console.error(`[token-refresh] Route returned ${response.status}`);
      return false;
    }

    console.log("[token-refresh] Refresh sweep completed");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[token-refresh] Request failed: ${message}`);
    return false;
  }
}
