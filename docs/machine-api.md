# Machine API

Two routes that let a script, such as the reel factory, create one campaign per
reel without a browser session. They are authenticated with a bearer key.

## Turning it on

Set `AUTOMATION_API_KEY` on the **web** service. It must be at least 32
characters. The worker does not need it, because it never serves these routes.

```bash
openssl rand -hex 32   # use the output as AUTOMATION_API_KEY
```

If the key is unset or too short, both routes return `503`. A missing or wrong
key returns `401`. The key is compared in constant time.

> The key can create campaigns on **every connected account in every
> workspace**. Treat it like a database password.

In the examples, `$OPENREPLY_URL` is the web service's public URL (the same
value as `NEXTAUTH_URL`).

## `GET /api/automations/machine/accounts`

Lists the connected Instagram accounts. Access tokens are never returned.

```bash
curl -s $OPENREPLY_URL/api/automations/machine/accounts \
  -H "Authorization: Bearer $AUTOMATION_API_KEY"
```

```json
{ "success": true, "data": [
  { "id": "cm…", "instagramId": "1784…", "username": "keithai_", "name": "Keith",
    "workspaceId": "cm…", "tokenOk": true, "tokenProblem": null,
    "tokenExpiresAt": "2026-11-28T…", "connectedAt": "2026-07-29T…" }
] }
```

`tokenProblem` is one of `missing`, `expired` or `invalid`. `invalid` means
Meta returned error 190. The fix is to **reconnect** the account. Do not click
Disconnect first: disconnecting cascade-deletes its campaigns and DM history.

## `POST /api/automations/machine/upsert`

Creates or updates **one** campaign. A campaign is identified by
`(instagramUsername, key)`. Sending the same key again updates that campaign
instead of creating a duplicate.

```bash
curl -s -X POST $OPENREPLY_URL/api/automations/machine/upsert \
  -H "Authorization: Bearer $AUTOMATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "instagramUsername": "@keithai_",
    "key": "ai-job-crew",
    "keywords": ["guide"],
    "dmMessage": "here is the guide, {username} 👇 {link}",
    "linkUrl": "https://www.vividsites.app/guides/ai-job-crew",
    "linkButtonLabel": "Get the guide",
    "publicReplyMessages": ["sent 📩", "check your DMs 👀"]
  }'
```

```json
{ "success": true, "data": {
  "id": "cm…", "created": true, "name": "reel:ai-job-crew", "isActive": true,
  "pendingNextReel": true, "postId": null,
  "trackedLinkSlug": "Xq3…", "trackedUrl": "https://…/r/Xq3…",
  "warnings": []
} }
```

A new campaign returns `201`, an update returns `200`. `warnings` never block
the write. They report a dead token, or an active any-post campaign that shares
a keyword. Meta allows one private reply per comment, so when two campaigns
match the same comment, one of the two DMs will fail.

### Fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `instagramUsername` | string, required | | Case-insensitive, and a leading `@` is ignored. `404` if the account isn't connected. |
| `key` | string, required | | Stable identity, for example the reel slug. Allowed: letters, digits, `.` `_` `:` `-`; at most 100 characters. |
| `name` | string | `reel:<key>` | On update, kept as it is unless you send it. |
| `goal` | string | `null` | On update, kept as it is unless you send it. |
| `keywords` | string[] 1–10 | | Duplicates are removed, using the same comparison as the matcher. A keyword with no letters or digits is rejected. |
| `wholeWordMatch` | boolean | `true` | |
| `dmMessage` | string ≤1000 | | Must contain `{link}` when `linkUrl` is set, and must not contain `{link}` when it isn't. Raw `http(s)://` and `www.` URLs are rejected. `{username}` is replaced with the commenter's name. |
| `linkUrl` | https URL | | Becomes the campaign's primary tracked link. On update only the destination changes. The slug never changes, so links in DMs already sent keep working. Leaving it out never deletes an existing link. |
| `linkButtonLabel` | string ≤20 | `Get the guide` | The DM button's title. |
| `requireFollow` | boolean | `false` | The follow gate. |
| `followPromptMessage` | string | worker default | Leave it blank to get "quick favor before i send your link…". |
| `followPromptButtonLabel` | string ≤20 | worker default | `i'm following` |
| `publicReplyMessages` | string[] ≤10 | `[]` | One is picked at random for each comment. A non-empty list turns public replies on; an empty list turns them off. |
| `postId` | string | | The Instagram media id. When set, the campaign is bound to that post now. |
| `postUrl` | URL | | Stored for display only, and it requires `postId`. |
| `isActive` | boolean | `true` | On update, kept as it is unless you send it, so a pause made in the dashboard survives a re-run. |

Unknown fields are rejected with `400`, so a typo can't silently drop a
setting.

**How updates work.** `name`, `goal`, `isActive` and an existing post binding
are only changed when you send them. Every other field is declarative: if you
leave it out, it goes back to its default. Opening DM, follow-up and second-link
settings are never touched, so they stay as they were set in the dashboard.

### Next reel vs. a specific post

- **No `postId`.** The campaign waits for a reel (`pendingNextReel: true`). The
  `attach-next-reel` cron binds it within about 5 minutes to the **earliest reel
  posted after the campaign was created**. So create the campaign *before*
  posting. A campaign created after its reel is posted will bind to the
  following reel.
- **Already bound.** If the cron (or an earlier call) has already bound the
  campaign, re-sending it without `postId` keeps that binding.
- **One waiting campaign per account.** The cron would attach every waiting
  campaign to the same reel, so a second waiting campaign is refused with
  `409`. Post the first reel, or pass `postId`.
- **One campaign per post.** This is the same rule as the CSV import. A `postId`
  that another campaign already uses is refused with `409`.

### How the link reaches the user

A campaign made here is stored with the same helpers as one made in the
dashboard builder (`lib/automations/campaign-fields.ts`). The worker therefore
sends it the same way: a button template whose `web_url` button is the tracked
link (`/r/<slug>`), or the destination itself when `DISABLE_LINK_TRACKING=1`.
`{link}` is removed from the body text. A raw URL in a plain-text DM is rejected
by Instagram with Meta error 508, which is why the API requires `{link}` and
forbids raw URLs.

### Errors

| Status | Meaning |
| --- | --- |
| 400 | Invalid input. `error` lists each problem as `field: message`, and `details` has the same as a list. |
| 401 | The `Authorization: Bearer` key is missing or wrong. |
| 404 | The Instagram account isn't connected. |
| 409 | The post is already used, another campaign is already waiting for the next reel, or two connected accounts share the username. |
| 503 | `AUTOMATION_API_KEY` is unset or shorter than 32 characters. |
