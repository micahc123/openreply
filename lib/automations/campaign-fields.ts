/**
 * Campaign field rules shared by every route that writes an Automation: the
 * dashboard (app/api/automations), the CSV import, and the machine API
 * (app/api/automations/machine/upsert). They live here so a campaign made by a
 * script is stored exactly like one made in the builder and goes down the same
 * worker path (lib/queue/dm-worker.ts) — they must not drift apart.
 */
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { stripSpecialCharacters } from "@/lib/utils/keyword-matcher";

/**
 * Label stored on a campaign's first tracked link. The worker treats the oldest
 * link (createdAt asc) as primary and titles its DM button from the campaign's
 * `linkButtonLabel`, not from this label.
 */
export const PRIMARY_TRACKED_LINK_LABEL = "Primary campaign link";

/**
 * A new primary tracked link. The slug is generated once and never changed
 * afterwards: links already sent in DMs keep resolving while the destination
 * is edited.
 */
export function buildPrimaryTrackedLinkCreate(
  workspaceId: string,
  destinationUrl: string
) {
  return {
    workspaceId,
    slug: generateTrackedLinkSlug(),
    label: PRIMARY_TRACKED_LINK_LABEL,
    destinationUrl,
  };
}

/**
 * Public-reply variations, trimmed with blanks dropped. Falls back to the
 * legacy single `publicReplyMessage` when no list was sent.
 */
export function normalizePublicReplyList(
  messages: string[] | undefined,
  legacySingle?: string | null
): string[] {
  const source =
    messages && messages.length > 0
      ? messages
      : legacySingle
        ? [legacySingle]
        : [];
  return source.map((m) => m.trim()).filter(Boolean);
}

/**
 * The three public-reply columns, kept in sync: the variations list, the
 * legacy single field (first variation), and the switch. Disabled clears both.
 */
export function publicReplyFields({
  enabled,
  list,
  legacySingle,
}: {
  enabled: boolean;
  list: string[];
  legacySingle?: string | null;
}) {
  return {
    publicReplyEnabled: enabled,
    publicReplyMessages: enabled ? list : [],
    publicReplyMessage: enabled ? (list[0] ?? legacySingle ?? null) : null,
  };
}

/**
 * Follow-gate columns. Blank prompt text is stored as null so the worker's
 * built-in defaults apply ("quick favor before i send your link…" and
 * "i'm following"); turning the gate off clears both.
 */
export function followGateFields({
  requireFollow,
  followPromptMessage,
  followPromptButtonLabel,
}: {
  requireFollow: boolean;
  followPromptMessage?: string | null;
  followPromptButtonLabel?: string | null;
}) {
  return {
    requireFollow,
    followPromptMessage: requireFollow ? followPromptMessage || null : null,
    followPromptButtonLabel: requireFollow
      ? followPromptButtonLabel || null
      : null,
  };
}

/** The form the keyword matcher compares on: punctuation/emoji stripped, lowercased. */
export function matchFormOfKeyword(keyword: string): string {
  return stripSpecialCharacters(keyword).toLowerCase();
}

/**
 * Trim keywords and drop duplicates that the matcher would treat as the same
 * word ("Guide", "guide!", " GUIDE "). The first spelling wins. Keywords that
 * reduce to nothing (only emoji/punctuation) are returned separately: the
 * matcher skips them, so they could never trigger a DM.
 */
export function normalizeKeywords(keywords: string[]): {
  keywords: string[];
  unmatchable: string[];
} {
  const seen = new Set<string>();
  const out: string[] = [];
  const unmatchable: string[] = [];
  for (const raw of keywords) {
    const keyword = raw.trim();
    if (!keyword) continue;
    const form = matchFormOfKeyword(keyword);
    if (!form) {
      unmatchable.push(keyword);
      continue;
    }
    if (seen.has(form)) continue;
    seen.add(form);
    out.push(keyword);
  }
  return { keywords: out, unmatchable };
}
