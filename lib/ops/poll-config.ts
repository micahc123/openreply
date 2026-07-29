/**
 * Comment poll interval configuration.
 *
 * In Phase 1 (Meta app in Development mode, no `comments` webhook) the polling
 * reconciler is the only trigger, so this value sets worst-case DM latency.
 * It becomes a backstop again once webhooks are live, at which point a longer
 * interval is appropriate.
 */

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Floor that protects the Business Use Case quota from a misconfiguration. */
export const MIN_POLL_INTERVAL_MS = 10_000;

export function getPollIntervalMs(): number {
  const raw = process.env.COMMENT_POLL_INTERVAL_MS;
  if (!raw) return DEFAULT_POLL_INTERVAL_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[poll-config] Invalid COMMENT_POLL_INTERVAL_MS="${raw}", using ${DEFAULT_POLL_INTERVAL_MS}ms`
    );
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return Math.max(parsed, MIN_POLL_INTERVAL_MS);
}
