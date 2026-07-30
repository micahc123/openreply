# OpenReply — ManyChat Replacement Design

**Date:** 2026-07-29
**Owner:** Micah Chen (@micahc123)
**Status:** Built and deployed. Phase 1 (no-App-Review) premise DISPROVEN 2026-07-30 — see Rollout phases. Blocked on Meta business verification + App Review.

## Problem

Instagram comment-to-DM automation currently runs on ManyChat. The account's
reach has grown to the point where ManyChat's contact quota is nearly exhausted,
and ManyChat prices by contact count. The funnel needs to keep working as reach
grows, without a bill that scales with it.

The automation itself is one feature: watch comments, match a keyword, send a
private reply through Meta's official API. Meta charges nothing for Instagram
messaging. The recurring cost is ManyChat's business model, not a platform cost.

## Decision

Adopt [`diwenne/openreply`](https://github.com/diwenne/openreply) (MIT) rather
than building from scratch. Fork to `micahc123/openreply`, deploy on Railway
Pro, apply three targeted changes, cut over from ManyChat.

### Why not build fresh on Cloudflare Workers

Cloudflare Workers was the earlier plan, chosen to satisfy a "must be free"
constraint. Two things retired that plan:

1. **A Railway Pro account already exists.** Postgres, Redis, and an always-on
   worker cost nothing at the margin. The constraint that pointed at Workers is
   gone.
2. **OpenReply is architecturally incompatible with Workers.** It needs a
   long-running BullMQ queue consumer. Workers has no always-on process, so a
   port is a rewrite, not a configuration change.

OpenReply already implements the operational edges that a from-scratch build
would take weeks to discover: an atomic Redis Lua rate-limit reservation, a
polling reconciler that backstops missed webhooks, encrypted token storage,
per-send logging with skip reasons, and a vitest suite. Upstream was last
committed 2026-07-23 and is actively maintained.

### Why fork rather than deploy upstream directly

A fork gives an owned repo that can carry local changes and still pull upstream
fixes, and insulates the deployment from force-pushes or deletion by a
single-maintainer upstream.

## Architecture

One Railway project, four services.

| Service | Role |
|---|---|
| `web` | Next.js 16 — dashboard, Instagram OAuth callback, `POST /api/webhook` |
| `worker` | `npm run worker` — BullMQ consumer plus the polling reconciler |
| Postgres | campaigns, DM logs, Instagram accounts, auth sessions |
| Redis | BullMQ send queue and the per-account rate counter |

`web` and `worker` must share `DATABASE_URL`, `REDIS_URL`, and `ENCRYPTION_KEY`
byte-for-byte. `web` writes the encrypted Instagram token; `worker` decrypts it
to send. A key mismatch makes every send fail at decrypt time, and the symptom
presents as "no DMs arriving" rather than as a key error — so this is configured
once as Railway shared variables, never per-service.

Railway's generated domain for `web` is the canonical public URL and feeds
`NEXTAUTH_URL`, the Meta OAuth redirect URI, and the Meta webhook callback URL.

### Data flow

1. A comment lands on a post or reel.
2. It reaches OpenReply by one of two paths — the polling reconciler (Phase 1)
   or the Meta `comments` webhook (Phase 2).
3. The comment is matched against active campaigns for that account.
4. On a keyword match, a send job is enqueued in BullMQ. The receiving path
   never sends inline.
5. The worker reserves a rate-limit slot, then sends the private reply and, if
   the campaign enables it, the public comment reply.
6. The outcome — sent, skipped, or failed with a reason — is written to the DM
   log.

The queue is the reason a viral reel degrades into a deeper backlog rather than
dropped DMs.

## Rollout phases

### Phase 1 — DISPROVEN 2026-07-30

**This phase does not work. Do not plan around it.**

The idea was: keep the Meta app in Development mode with the Instagram account
added as an Instagram Tester, skip the `comments` webhook, and let the polling
reconciler drive everything — putting App Review off the critical path.

Tested against the live account and it fails. Over 8+ minutes of 60s sweeps the
reconciler reported, every time:

```
media=10 comments=0 own=0 matched=0 alreadyReplied=0 enqueued=0   errors=[]
```

Media listing works (the account's own data, covered by basic scope). The
comments edge returns **HTTP 200 with an empty list** — no error — even though
the post visibly had many keyword comments hours old.

Cause: in Development mode an app may only access data belonging to users who
hold a role on it. Comments by members of the public are *their* data, and a
comment-to-DM funnel exists precisely to act on strangers' comments. Meta's
webhooks documentation states it directly for the `comments` field: **"Advanced
Access is required."** That constraint governs reading comment data at all, not
just webhook delivery.

The empty-list-instead-of-error behaviour is what made this expensive to
diagnose: nothing anywhere reports a permission problem.

### Phase 1 (actual) — App Review is a prerequisite

Advanced Access on `instagram_business_basic`,
`instagram_business_manage_comments`, and `instagram_business_manage_messages`,
which requires business verification (a document proving a legal entity).

Until that is granted, ManyChat remains the live funnel and its subscription
must not be cancelled. The deployment stays provisioned and ready; it becomes
functional the moment Advanced Access lands.

### The tester-role workaround does NOT work either (tested 2026-07-30)

A second account (`micahc71`) was added as an Instagram Tester and **accepted**
the invite, then commented a configured keyword on a recent post. Sweeps stayed
at `seen=0 own=0 matched=0` while confirmed live (row ages cycling 7–48s).

So Development mode serves **no comment data at all** — not even for accounts
holding a role on the app. Reading the comments edge requires Advanced Access,
full stop. An earlier revision of this document claimed the tester role was a
viable screencast workaround; that claim was untested and is false.

### Untested hypothesis: the webhook path may still be open

Polling and webhooks are different mechanisms. The blocked one is *reading* the
comments edge. The `comments` **webhook pushes the `comment_id` to us**, so it
never reads that edge — and a private reply only needs a `comment_id`.

Meta requires the app to be in **published (Live)** state to receive webhooks,
and publishing is a separate switch from App Review; per Meta's own setup text it
may be permitted for tester accounts before review. If so, the sequence is:

1. Set privacy / terms / data-deletion URLs (required to publish).
2. Publish the app (reversible).
3. Configure the webhook: callback `/api/webhook`, the `WEBHOOK_VERIFY_TOKEN`
   value, subscribe to the `comments` field.
4. Comment from a tester account.

**This is a hypothesis, not a verified result.** It is plausible because it
routes around the specific thing observed to be blocked, but the original plan
deliberately avoided publishing and webhooks in favour of polling — which turned
out to be exactly backwards, since polling is the path dev mode blocks.

If publishing is refused pending review, App Review is unavoidable and the
screencast has to be produced after Advanced Access is granted.

Note `META_APP_REVIEW.md` (upstream) opens by saying review is unnecessary if
you run OpenReply for your own accounts. That is wrong for this use case and is
what this design originally anchored on.

### Phase 2 — webhooks

Complete business verification and App Review for the `comments` webhook field,
then subscribe. Latency drops to roughly two seconds. The polling reconciler
stays enabled as a safety net for events the webhook misses.

## Changes to the fork

### 1. Rate-limit headroom — `lib/utils/rate-limiter.ts`

`RATE_LIMIT_MAX` goes from 750 to 600 per hour per account. Meta documents 750
private replies per hour for post and reel comments; upstream sets the constant
to exactly that and its own comment describes it as "a hard ceiling with no
headroom." If Meta throttles early, or other calls share the bucket, the result
is 429s. 600/hour still drains roughly 14,000 DMs per day, far above need.

### 2. Poll interval — `COMMENT_POLL_INTERVAL_MS`

Default drops from 5 minutes to 60 seconds. Upstream's default assumes polling
is a backup to webhooks; in Phase 1 it is the only trigger, so the default sets
worst-case DM latency. The added API calls draw on the Business Use Case bucket,
which is `4800 × impressions` per 24 hours and therefore not a practical
constraint at this account's reach.

This value returns to a longer interval in Phase 2, when it reverts to being a
backstop.

### 3. Token refresh on Railway — `app/api/cron/refresh-tokens/route.ts`

The route exists but is written to be driven by Vercel Cron, which is not
present in a Railway deployment. Long-lived Instagram tokens expire at roughly
60 days, silently, and an unrefreshed token is the most common way a
self-hosted setup dies two months after it is set up.

A Railway scheduled job will call the route with the `CRON_SECRET` bearer token
on a daily cadence.

## Campaign configuration

Keyword(s), Instagram handle, and message copy are entered through the dashboard
at runtime. They are configuration, not build-time decisions, and can change per
post without a deploy.

Fixed by this design:

- **Destination:** `https://www.uiprompts.app/`, wrapped in OpenReply's tracked
  redirect so click count and CTR are recorded per campaign.
- **Personalization:** `{username}` in the message body.
- **Public reply:** enabled, so a visible comment reply posts alongside the DM.

## Known gap: identical message copy

OpenReply sends one fixed message body per campaign. It has no variant rotation
— verified by inspection, there is no such field in the schema and no rotation
logic in `lib/`.

Meta's rate limits and its spam heuristics are separate enforcement systems.
Staying under the documented cap does not exempt an account from action for
sending hundreds of byte-identical DMs per hour, and at 600/hour that is the
current behaviour.

This is **deferred, not solved**. It is not a regression against ManyChat, which
also sends fixed copy, so it does not block cutover. If it becomes a concern,
the fix is small: a variant array on the campaign, selected by a hash of the
comment ID so retries stay deterministic. Revisit after the first high-volume
reel, with the DM logs as evidence.

## External dependencies

- **Meta developer app** using Instagram API with Instagram Login.
- **Instagram Business or Creator account.** A personal account cannot connect.
- **Resend account with a verified sender domain.** Authentication is email
  magic links only — without Resend, dashboard login is impossible. This is a
  hard blocker if discovered mid-setup rather than provisioned up front.
- **Railway Pro** (already held).

## ManyChat cutover

Ordered, because overlap is user-visible:

1. Pause the ManyChat keyword flow.
2. Post a test comment from a second Instagram account.
3. Confirm the DM arrives and a corresponding DM log entry exists.
4. Only then publish the next reel.

Both systems live at once means both fire a private reply for the same comment.
Meta permits one private reply per comment, so the second call errors, and
during the overlap some commenters receive two DMs.

ManyChat stays subscribed but paused until contact history is exported, then it
is cancelled.

## Error handling

- **Over rate limit:** the job requeues on a 30-minute delay, up to 3 attempts,
  then logs a skip with a reason rather than silently dropping.
- **Concurrent sends:** slot reservation is a single atomic Redis Lua script, so
  parallel workers cannot all pass the check before any increments the counter.
- **Private reply window:** Meta allows a private reply up to 7 days after the
  comment. Jobs older than the window are logged as expired rather than retried
  indefinitely.
- **Duplicate delivery:** de-duplication is keyed on comment ID, which matters
  most in Phase 1 where polling re-reads the same comment list every minute.
- **Self-comments:** filtered before send; Meta rejects DMing your own account.

## Verification

- `npm test` (vitest) passes on the fork before first deploy. Existing coverage
  includes the keyword matcher, rate limiter, webhook handler, and DM worker.
- A regression test pins `RATE_LIMIT_MAX` at 600, so an upstream merge cannot
  silently restore 750.
- `/api/health` plus the worker heartbeat confirm both processes are live —
  the failure mode where `web` is up and `worker` is dead looks exactly like
  "the automation stopped working."
- End-to-end: a real comment from a burner account produces a DM and a log row.

## Out of scope

- Multi-account and workspace/role features. Upstream supports them; this
  deployment uses one Instagram account and one operator.
- The dashboard Inbox feature.
- Any change to reel production, which stays in `~/Developer/vidgenpro`.
- Migrating historical ManyChat contacts or conversation history.
