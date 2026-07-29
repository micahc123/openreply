import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { getPollIntervalMs } from "@/lib/ops/poll-config";
import {
  pingTokenRefresh,
  TOKEN_REFRESH_INTERVAL_MS,
} from "@/lib/ops/token-refresh-ping";
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
setTimeout(() => void pingTokenRefresh(), 60_000);
const tokenRefreshTimer = setInterval(
  () => void pingTokenRefresh(),
  TOKEN_REFRESH_INTERVAL_MS
);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(tokenRefreshTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
