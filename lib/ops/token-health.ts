/**
 * Dead-token detection.
 *
 * Meta invalidates a long-lived token whenever the user changes their password
 * or Meta runs a security action — independently of expiry. Every subsequent
 * send then fails with code 190 (TokenExpiredError), and the only fix is the
 * account owner re-authorising.
 *
 * Before this existed, TokenExpiredError was thrown and never handled: the
 * worker logged one more FAILED row and carried on. A dead token produced 578
 * identical failures over 36 hours with no alert, no health signal, and a
 * wasted API call per comment. The outage was invisible until someone noticed
 * DMs had stopped.
 *
 * So a 190 now: marks the account in Redis (short TTL, refreshed on each
 * occurrence), records ONE OperationalEvent per hour per account so the log
 * shows the cause without 578 duplicates, and flips /api/health to degraded so
 * it is externally monitorable.
 */

import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";

const KEY_PREFIX = "health:token-invalid:";
/** Long enough to survive a quiet period, short enough to self-clear on fix. */
const TTL_SECONDS = 3 * 60 * 60;
/** One OperationalEvent per account per hour, not one per failed send. */
const EVENT_THROTTLE_SECONDS = 60 * 60;

export interface InvalidToken {
  instagramAccountId: string;
  username: string;
  message: string;
  since: string;
}

export async function recordTokenInvalid(params: {
  instagramAccountId: string;
  username: string;
  workspaceId: string;
  message: string;
}): Promise<void> {
  const redis = getRedisConnection();
  const key = `${KEY_PREFIX}${params.instagramAccountId}`;

  try {
    const existing = await redis.get(key);
    const payload: InvalidToken = {
      instagramAccountId: params.instagramAccountId,
      username: params.username,
      message: params.message,
      // Keep the ORIGINAL time so the alert shows how long it has been broken,
      // not when it last retried.
      since: existing ? (JSON.parse(existing) as InvalidToken).since : new Date().toISOString(),
    };
    await redis.set(key, JSON.stringify(payload), "EX", TTL_SECONDS);

    // Throttle the DB event separately: the Redis key is refreshed constantly,
    // but the operational log should get one row an hour, not hundreds.
    const eventKey = `${key}:event`;
    const fresh = await redis.set(eventKey, "1", "EX", EVENT_THROTTLE_SECONDS, "NX");
    if (fresh) {
      await prisma.operationalEvent.create({
        data: {
          workspaceId: params.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message:
            `Instagram token for @${params.username} is INVALID — every DM is failing. ` +
            `Meta says: ${params.message}. Fix: reconnect the account in Settings. ` +
            `Do NOT click Disconnect first — that cascade-deletes campaigns and DM history.`,
          payload: { instagramAccountId: params.instagramAccountId, username: params.username },
        },
      }).catch(() => {});
    }
  } catch {
    // Never let health bookkeeping break a send path.
  }
}

/** Clear the marker once a send succeeds again. */
export async function clearTokenInvalid(instagramAccountId: string): Promise<void> {
  try {
    await getRedisConnection().del(`${KEY_PREFIX}${instagramAccountId}`);
  } catch {
    /* ignore */
  }
}

export async function getInvalidTokens(): Promise<InvalidToken[]> {
  try {
    const redis = getRedisConnection();
    const keys = await redis.keys(`${KEY_PREFIX}*`);
    const out: InvalidToken[] = [];
    for (const k of keys) {
      if (k.endsWith(":event")) continue;
      const raw = await redis.get(k);
      if (raw) out.push(JSON.parse(raw) as InvalidToken);
    }
    return out;
  } catch {
    return [];
  }
}

/** Is this account's token currently known-bad? */
export async function isTokenInvalid(instagramAccountId: string): Promise<boolean> {
  try {
    return (await getRedisConnection().get(`${KEY_PREFIX}${instagramAccountId}`)) !== null;
  } catch {
    // If we cannot tell, assume healthy — never block sends on a Redis blip.
    return false;
  }
}
