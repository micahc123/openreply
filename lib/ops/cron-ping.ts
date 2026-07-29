/**
 * Cron-route trigger.
 *
 * app/api/cron/* routes are written for Vercel Cron. This deployment runs on
 * Railway, which has no Vercel Cron equivalent, so the always-on worker
 * triggers each route on its own interval instead.
 *
 * Never throws. A failed ping must not take the worker down — the DM queue
 * matters more, and every route here is idempotent, so the next tick retries.
 */

import { getBaseUrl } from "@/lib/env";

// app/api/cron/refresh-tokens: rotates Instagram long-lived tokens before
// they expire (~60 days) and resets monthly usage counters. A daily sweep is
// plenty of margin against a 60-day expiry.
export const TOKEN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// app/api/cron/attach-next-reel: binds pendingNextReel campaigns to a newly
// posted reel. Instagram sends no webhook on publish, so this must be
// polled. Vercel's free plan caps crons at once a day; the worker has no
// such limit, so this runs every 5 minutes and a campaign goes live within
// minutes of the reel posting instead of up to a day later.
export const REEL_ATTACH_INTERVAL_MS = 5 * 60 * 1000;

// Derives a short label from the route path so worker logs stay
// distinguishable between routes, e.g. "/api/cron/attach-next-reel" ->
// "attach-next-reel".
function labelFor(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export async function pingCronRoute(
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const label = labelFor(path);
  const secret = process.env.CRON_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    console.error(`[cron-ping:${label}] No CRON_SECRET or NEXTAUTH_SECRET set`);
    return false;
  }

  const url = `${getBaseUrl()}${path}`;

  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${secret}` },
    });

    if (!response.ok) {
      console.error(`[cron-ping:${label}] Route returned ${response.status}`);
      return false;
    }

    console.log(`[cron-ping:${label}] Sweep completed`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[cron-ping:${label}] Request failed: ${message}`);
    return false;
  }
}
