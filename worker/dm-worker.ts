import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { getPollIntervalMs } from "@/lib/ops/poll-config";
import {
  pingCronRoute,
  TOKEN_REFRESH_INTERVAL_MS,
  REEL_ATTACH_INTERVAL_MS,
} from "@/lib/ops/cron-ping";
import os from "node:os";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
const HEARTBEAT_INTERVAL_MS = 30_000;
// Comment polling. In Phase 1 this is the primary trigger, not a safety net —
// see lib/ops/poll-config.ts.
const POLL_INTERVAL_MS = getPollIntervalMs();

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

// Instagram long-lived tokens expire at ~60 days. The route is idempotent and
// only acts on tokens within 10 days of expiry, so a daily sweep is enough.
// First run is delayed 60s so the web service is up before the first call.
setTimeout(() => void pingCronRoute("/api/cron/refresh-tokens"), 60_000);
const tokenRefreshTimer = setInterval(
  () => void pingCronRoute("/api/cron/refresh-tokens"),
  TOKEN_REFRESH_INTERVAL_MS
);

// Instagram sends no webhook when a new reel is published, so campaigns
// awaiting the creator's "next reel" need polling to bind. Vercel's free
// plan caps crons at once a day; the worker has no such limit, so this runs
// every 5 minutes and a campaign goes live within minutes of the reel
// posting. First run staggered 30s after the token-refresh ping so the two
// don't fire together on boot.
setTimeout(() => void pingCronRoute("/api/cron/attach-next-reel"), 90_000);
const reelAttachTimer = setInterval(
  () => void pingCronRoute("/api/cron/attach-next-reel"),
  REEL_ATTACH_INTERVAL_MS
);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(tokenRefreshTimer);
  clearInterval(reelAttachTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
