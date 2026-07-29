# OpenReply ManyChat Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a forked OpenReply on Railway to replace ManyChat for Instagram comment-to-DM, with the funnel pointing at `https://www.uiprompts.app/`.

**Architecture:** Four Railway services (Next.js web, always-on BullMQ worker, Postgres, Redis) sharing one set of variables. Phase 1 runs the Meta app in Development mode with the polling reconciler as the primary trigger, keeping Meta App Review off the critical path. Three code changes harden the fork: rate-limit headroom, a poll-interval config that cannot degrade into a tight loop, and a token-refresh trigger that does not depend on Vercel Cron.

**Tech Stack:** Next.js 16, React 19, Prisma 7 + PostgreSQL, BullMQ + Redis, Auth.js with Resend magic links, vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-29-openreply-manychat-replacement-design.md`

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `lib/utils/rate-limiter.ts` | Hourly private-reply cap, atomic Redis slot reservation | Modify (one constant + comment) |
| `lib/ops/poll-config.ts` | Parse and validate the comment-poll interval | Create |
| `lib/ops/token-refresh-ping.ts` | Call the token-refresh route on a schedule from the worker | Create |
| `worker/dm-worker.ts` | Worker entrypoint: queue consumer, heartbeat, poll, token refresh | Modify |
| `__tests__/rate-limiter.test.ts` | Existing rate-limiter tests + new value pin | Modify |
| `__tests__/poll-config.test.ts` | Poll-interval parsing and fallback | Create |
| `__tests__/token-refresh-ping.test.ts` | Refresh ping auth header and failure handling | Create |
| `docs/setup.md` | Env var reference table | Modify (one row) |

Two new files rather than inline constants in `worker/dm-worker.ts`: that file executes its logic at import time, so anything left inside it cannot be unit tested without booting a worker, a Redis connection, and a database.

---

## Part A — Code changes

### Task 1: Rate-limit headroom

Meta documents 750 private replies per hour for post and reel comments. Upstream sets the constant to exactly that; its own source comment calls it "a hard ceiling with no headroom." Dropping to 600 still drains ~14,000 DMs/day.

The existing test file deliberately derives its assertions from `RATE_LIMIT_MAX`, so it will keep passing at any value. That is good for the behavioural tests but means nothing pins the number — an upstream merge could silently restore 750. This task adds that pin.

**Files:**
- Modify: `lib/utils/rate-limiter.ts:21`
- Test: `__tests__/rate-limiter.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/rate-limiter.test.ts`:

```typescript
describe("rate limit ceiling", () => {
  // Deliberate value pin. Every other assertion in this file derives from
  // RATE_LIMIT_MAX and so survives any change to it. This test exists to fail
  // loudly if an upstream merge restores Meta's raw documented 750, which
  // leaves no headroom for throttling or for other calls sharing the bucket.
  it("keeps headroom under Meta's documented 750/hour ceiling", () => {
    expect(RATE_LIMIT_MAX).toBe(600);
  });

  it("still allows well above real daily volume", () => {
    expect(RATE_LIMIT_MAX * 24).toBeGreaterThan(10_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Developer/openreply && npx vitest run __tests__/rate-limiter.test.ts -t "headroom"
```

Expected: FAIL — `expected 750 to be 600`

- [ ] **Step 3: Change the constant**

In `lib/utils/rate-limiter.ts`, replace line 21:

```typescript
const RATE_LIMIT_MAX = 750; // private replies per hour, per Meta's documented cap
```

with:

```typescript
// Meta documents 750 private replies/hour per account for post and reel
// comments. We run at 600 to keep headroom: Meta may throttle before the
// documented limit, and other calls on the same account share the bucket.
// Pinned by __tests__/rate-limiter.test.ts so an upstream merge cannot
// silently restore 750.
const RATE_LIMIT_MAX = 600;
```

- [ ] **Step 4: Run the full rate-limiter suite**

```bash
cd ~/Developer/openreply && npx vitest run __tests__/rate-limiter.test.ts
```

Expected: PASS, all tests. The pre-existing tests derive from `RATE_LIMIT_MAX` and must still pass unchanged — if any fails, it was hardcoding 750 and needs to derive from the constant instead.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/openreply
git add lib/utils/rate-limiter.ts __tests__/rate-limiter.test.ts
git commit -m "fix: run private replies at 600/hour for rate-limit headroom"
```

---

### Task 2: Poll interval config

In Phase 1 the polling reconciler is the only trigger, so this interval sets worst-case DM latency. Upstream defaults to 5 minutes because it treats polling as a webhook backstop.

There is also a latent bug. `worker/dm-worker.ts:11-13` reads:

```typescript
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);
```

A malformed value (`"60s"`, `"1 minute"`, a stray space) makes `Number()` return `NaN`. `setInterval(fn, NaN)` coerces the delay to `0`, so the worker would sweep Instagram's API in a continuous loop — burning the Business Use Case quota and looking like abuse. A typo in a Railway variable should not be able to do that.

**Files:**
- Create: `lib/ops/poll-config.ts`
- Create: `__tests__/poll-config.test.ts`
- Modify: `worker/dm-worker.ts:9-14`

- [ ] **Step 1: Write the failing test**

Create `__tests__/poll-config.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Developer/openreply && npx vitest run __tests__/poll-config.test.ts
```

Expected: FAIL — cannot resolve `../lib/ops/poll-config`

- [ ] **Step 3: Write the implementation**

Create `lib/ops/poll-config.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Developer/openreply && npx vitest run __tests__/poll-config.test.ts
```

Expected: PASS, 5 tests

- [ ] **Step 5: Wire it into the worker**

In `worker/dm-worker.ts`, replace lines 9-14:

```typescript
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
);
```

with:

```typescript
// Comment polling. In Phase 1 this is the primary trigger, not a safety net —
// see lib/ops/poll-config.ts.
const POLL_INTERVAL_MS = getPollIntervalMs();
```

and add to the imports at the top of the file:

```typescript
import { getPollIntervalMs } from "@/lib/ops/poll-config";
```

- [ ] **Step 6: Typecheck**

```bash
cd ~/Developer/openreply && npm run typecheck
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/openreply
git add lib/ops/poll-config.ts __tests__/poll-config.test.ts worker/dm-worker.ts
git commit -m "fix: validate poll interval and default to 60s for phase 1

Number('60s') is NaN and setInterval(fn, NaN) coerces to 0, so a typo in
COMMENT_POLL_INTERVAL_MS would sweep the Instagram API in a tight loop."
```

---

### Task 3: Token refresh without Vercel Cron

`app/api/cron/refresh-tokens/route.ts` refreshes Instagram long-lived tokens nearing expiry and resets monthly usage counters. It is written to be driven by Vercel Cron, which does not exist in a Railway deployment. Long-lived tokens expire at ~60 days silently — an unrefreshed token is the most common way a self-hosted setup dies two months in.

The worker is already always-on and already runs interval timers, so it triggers the route rather than adding a fifth Railway service.

**Files:**
- Create: `lib/ops/token-refresh-ping.ts`
- Create: `__tests__/token-refresh-ping.test.ts`
- Modify: `worker/dm-worker.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/token-refresh-ping.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Developer/openreply && npx vitest run __tests__/token-refresh-ping.test.ts
```

Expected: FAIL — cannot resolve `../lib/ops/token-refresh-ping`

- [ ] **Step 3: Write the implementation**

Create `lib/ops/token-refresh-ping.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Developer/openreply && npx vitest run __tests__/token-refresh-ping.test.ts
```

Expected: PASS, 5 tests

- [ ] **Step 5: Wire it into the worker**

In `worker/dm-worker.ts`, add to the imports:

```typescript
import {
  pingTokenRefresh,
  TOKEN_REFRESH_INTERVAL_MS,
} from "@/lib/ops/token-refresh-ping";
```

After the existing `const pollTimer = setInterval(...)` line, add:

```typescript
// Instagram long-lived tokens expire at ~60 days. The route is idempotent and
// only acts on tokens within 10 days of expiry, so a daily sweep is enough.
// First run is delayed 60s so the web service is up before the first call.
setTimeout(() => void pingTokenRefresh(), 60_000);
const tokenRefreshTimer = setInterval(
  () => void pingTokenRefresh(),
  TOKEN_REFRESH_INTERVAL_MS
);
```

In the `shutdown` function, add `clearInterval(tokenRefreshTimer);` alongside the existing `clearInterval(pollTimer);`.

- [ ] **Step 6: Typecheck and run the full suite**

```bash
cd ~/Developer/openreply && npm run typecheck && npm test
```

Expected: no type errors; all tests pass

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/openreply
git add lib/ops/token-refresh-ping.ts __tests__/token-refresh-ping.test.ts worker/dm-worker.ts
git commit -m "feat: trigger token refresh from the worker instead of Vercel Cron"
```

---

### Task 4: Update the env reference

`docs/setup.md:109` documents the old 5-minute default and would now mislead.

**Files:**
- Modify: `docs/setup.md:109`

- [ ] **Step 1: Update the table row**

Replace:

```markdown
| `COMMENT_POLL_INTERVAL_MS` | `300000` | How often the worker sweeps for missed comments (5 min). |
```

with:

```markdown
| `COMMENT_POLL_INTERVAL_MS` | `60000` | How often the worker sweeps for comments (60s). This is the primary trigger while the Meta app is in Development mode without a `comments` webhook. Raise it to `300000` once webhooks are live and polling is only a backstop. Values below `10000`, non-numeric values, and zero or negative values fall back to safe defaults. |
```

- [ ] **Step 2: Commit**

```bash
cd ~/Developer/openreply
git add docs/setup.md
git commit -m "docs: update poll interval default and bounds"
```

---

### Task 5: Verify the whole suite and push

- [ ] **Step 1: Run everything**

```bash
cd ~/Developer/openreply && npm run typecheck && npm run lint && npm test
```

Expected: clean typecheck, clean lint, all tests pass. Record the test count.

- [ ] **Step 2: Push the fork**

```bash
cd ~/Developer/openreply && git push origin main
```

---

## Part B — Provisioning

These steps happen in a browser and require account access. An agent cannot complete them.

### Task 6: Railway project

**Prerequisite:** Railway Pro account (held).

- [ ] Create a new Railway project named `openreply`.
- [ ] Add a PostgreSQL database. Copy its `DATABASE_URL`.
- [ ] Add a Redis database. Copy its `REDIS_URL`.
- [ ] Add a service from the GitHub repo `micahc123/openreply`. Name it `web`. Start command: `npm run start`. Build command: `npm run build`.
- [ ] Add a second service from the same repo. Name it `worker`. Start command: `npm run worker`. **No public domain.**
- [ ] Generate a public domain for `web`. Record it — this value is `NEXTAUTH_URL`, the Meta OAuth redirect base, and the webhook callback base.
- [ ] Set these as **shared variables** at the project level so `web` and `worker` receive identical values. `ENCRYPTION_KEY` mismatch between the two services makes every send fail at decrypt time, and the symptom presents as "no DMs arriving" rather than as a key error.

Take `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, and `WEBHOOK_VERIFY_TOKEN` from the local `~/Developer/openreply/.env`, which already has generated values.

```
NEXTAUTH_URL=https://<your-web-domain>
NEXTAUTH_SECRET=<from local .env>
CRON_SECRET=<from local .env>
ENCRYPTION_KEY=<from local .env>
WEBHOOK_VERIFY_TOKEN=<from local .env>
DATABASE_URL=<from Railway Postgres>
REDIS_URL=<from Railway Redis>
RESEND_API_KEY=<from local .env>
EMAIL_FROM=OpenReply <login@rumjahn.com>
META_GRAPH_API_VERSION=v25.0
COMMENT_POLL_INTERVAL_MS=60000
INSTAGRAM_APP_ID=<Task 7>
INSTAGRAM_APP_SECRET=<Task 7>
FACEBOOK_APP_SECRET=<Task 7>
```

- [ ] Run the migration once against the Railway database:

```bash
cd ~/Developer/openreply && DATABASE_URL="<railway-postgres-url>" npx prisma migrate deploy
```

- [ ] Confirm `web` is up: `curl https://<your-web-domain>/api/health`
- [ ] Confirm the worker booted: check its Railway logs for `[DM Worker] Started`.

`rumjahn.com` is the only verified Resend domain on the account, so `EMAIL_FROM` must use it. These emails are your own login links, so the domain has no bearing on the funnel.

### Task 7: Meta app — Phase 1, Development mode

Budget an afternoon. `docs/setup.md` and `META_APP_REVIEW.md` in this repo cover the wrong turns in detail.

- [ ] Confirm the target Instagram account is a **Business or Creator** account. A personal account cannot connect.
- [ ] Create a Meta developer app at developers.facebook.com. Add the **Instagram** product, using **Instagram API with Instagram Login**.
- [ ] Add your Instagram account under app roles with the **Instagram Tester** role, then accept the invite from within Instagram. Development mode only interacts with accounts holding a role on the app — this is what makes Phase 1 work without App Review.
- [ ] Set the OAuth redirect URI to `https://<your-web-domain>/api/instagram/callback`.
- [ ] Copy `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and `FACEBOOK_APP_SECRET` into the Railway shared variables.
- [ ] **Do not** subscribe to the `comments` webhook yet. That field requires Advanced Access plus business verification, and Phase 1 deliberately runs on polling instead.
- [ ] Redeploy both services so they pick up the new variables.

### Task 8: Connect and configure

- [ ] Log into `https://<your-web-domain>` using an emailed magic link. If it does not arrive, check the Resend dashboard logs — this is the most common setup failure and it is almost always a sender-domain mismatch.
- [ ] Connect the Instagram account through the dashboard OAuth flow.
- [ ] Create a campaign:
  - Keyword(s): the word your captions actually tell people to comment.
  - Match mode: whole-word, so "setup" inside a sentence does not fire unintentionally.
  - Message body: include `{username}` for personalization.
  - Link: `https://www.uiprompts.app/`, with tracked redirect enabled so click count and CTR are recorded.
  - Public reply: enabled.
- [ ] Attach the campaign to an existing post and confirm it shows as active.

---

## Part C — Cutover

### Task 9: Verify before switching

- [ ] **Pause the ManyChat flow first.** Both systems live at once means both fire a private reply for the same comment. Meta permits one private reply per comment, so the second call errors and, during the overlap, some commenters receive two DMs.
- [ ] Comment the keyword from a **second Instagram account** — not your own. Self-comments are filtered before send, because Meta rejects DMing your own account, so testing from the account itself proves nothing.
- [ ] Confirm within ~60s: the DM arrives, the public reply posts, and a row appears in the dashboard DM log with status sent.
- [ ] Click the tracked link from the DM and confirm the click registers against the campaign.
- [ ] Check the Railway `worker` logs for the reconciliation sweep and for `[DM Worker] Started`.

If no DM arrives, check in this order: is the `worker` service running (a dead worker with a healthy `web` looks exactly like "the automation stopped"), then whether `ENCRYPTION_KEY` is identical across both services, then the DM log's skip reason.

- [ ] Publish the next reel with the keyword in the caption.
- [ ] Watch the DM log through the first hour of real volume. Confirm no rate-limit skips at 600/hour.

### Task 10: Decommission and record

- [ ] Export ManyChat contact history if you want to keep it.
- [ ] Cancel the ManyChat subscription.
- [ ] Rotate the Resend API key — it was pasted into a chat transcript on 2026-07-29.
- [ ] Update `~/ObsidianVault/00-index/active-tasks.md` and `projects.md`, and write a distilled session note to `~/ObsidianVault/Sessions/`.

---

## Deferred

- **Message copy rotation.** OpenReply sends one fixed body per campaign; there is no variant field in the schema and no rotation logic in `lib/`. Meta's rate limits and its spam heuristics are separate enforcement systems, so identical copy at volume carries some risk. This is not a regression against ManyChat, which also sends fixed copy, so it does not block cutover. Revisit after the first high-volume reel with the DM logs as evidence. The fix is a variant array selected by a hash of the comment ID, so retries stay deterministic.
- **Phase 2 webhooks.** Business verification plus App Review for the `comments` field, then subscribe and raise `COMMENT_POLL_INTERVAL_MS` back to `300000`. Drops latency from ~60s to ~2s. Not on the critical path.
- **Multi-account, workspaces, and the Inbox.** Supported upstream, unused here.
