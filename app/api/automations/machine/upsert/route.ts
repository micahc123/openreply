import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireMachineAuth } from "@/lib/machine-api/auth";
import {
  getTokenProblem,
  resolveInstagramAccountByUsername,
} from "@/lib/machine-api/accounts";
import {
  buildPrimaryTrackedLinkCreate,
  followGateFields,
  normalizeKeywords,
  normalizePublicReplyList,
  publicReplyFields,
} from "@/lib/automations/campaign-fields";
import { generateReportShareSlug } from "@/lib/reports/share";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

export const dynamic = "force-dynamic";

/**
 * POST /api/automations/machine/upsert
 *
 * Create or update ONE campaign from a script (the reel factory), identified by
 * (instagram account, `key`). Bearer-key auth (AUTOMATION_API_KEY). Full field
 * reference and curl examples: docs/machine-api.md.
 *
 * The campaign is stored with the same helpers as the dashboard builder
 * (lib/automations/campaign-fields.ts), so the worker treats it identically:
 * `linkUrl` becomes the primary TrackedLink, the DM goes out as a button
 * template whose web_url button is that link, and `{link}` is stripped from the
 * body text.
 */

const DEFAULT_MACHINE_LINK_BUTTON_LABEL = "Get the guide";

const LINK_TOKEN = /\{link\}/i;
// A raw URL in a DM is what Meta rejects with error 508. Links must go in
// `linkUrl`, which travels as a web_url button.
const RAW_URL = /https?:\/\/|\bwww\./i;

const machineUpsertSchema = z
  .strictObject({
    instagramUsername: z.string().trim().min(1).max(64),
    key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        "key may contain letters, digits, '.', '_', ':' and '-', starting with a letter or digit"
      ),
    name: z.string().trim().min(1).max(100).optional(),
    goal: z.string().trim().min(1).max(120).optional(),
    keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(10),
    wholeWordMatch: z.boolean().optional().default(true),
    dmMessage: z.string().trim().min(1).max(1000),
    linkUrl: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((u) => /^https:\/\//i.test(u), "linkUrl must be an https URL")
      .optional(),
    linkButtonLabel: z
      .string()
      .trim()
      .min(1)
      .max(20) // Meta's limit for a button title
      .optional()
      .default(DEFAULT_MACHINE_LINK_BUTTON_LABEL),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().trim().max(1000).optional(),
    followPromptButtonLabel: z.string().trim().max(20).optional(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    postId: z.string().trim().min(1).max(64).optional(),
    postUrl: z.string().trim().url().optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    const hasToken = LINK_TOKEN.test(d.dmMessage);
    if (d.linkUrl && !hasToken) {
      ctx.addIssue({
        code: "custom",
        path: ["dmMessage"],
        message:
          "dmMessage must contain {link} when linkUrl is set. The link is delivered as a button; {link} marks it in the message.",
      });
    }
    if (!d.linkUrl && hasToken) {
      ctx.addIssue({
        code: "custom",
        path: ["dmMessage"],
        message:
          "dmMessage contains {link} but no linkUrl was given, so {link} would be sent as literal text",
      });
    }
    if (RAW_URL.test(d.dmMessage)) {
      ctx.addIssue({
        code: "custom",
        path: ["dmMessage"],
        message:
          "dmMessage must not contain a raw URL (Instagram rejects it, Meta error 508). Put the URL in linkUrl and write {link}.",
      });
    }
    if (!d.linkUrl) {
      d.publicReplyMessages.forEach((m, i) => {
        if (LINK_TOKEN.test(m)) {
          ctx.addIssue({
            code: "custom",
            path: ["publicReplyMessages", i],
            message:
              "public reply contains {link} but no linkUrl was given, so {link} would be posted as literal text",
          });
        }
      });
    }
    const { unmatchable } = normalizeKeywords(d.keywords);
    for (const keyword of unmatchable) {
      ctx.addIssue({
        code: "custom",
        path: ["keywords"],
        message: `keyword "${keyword}" has no letters or digits, so it can never match a comment`,
      });
    }
    if (d.postUrl && !d.postId) {
      ctx.addIssue({
        code: "custom",
        path: ["postId"],
        message:
          "postUrl needs postId (the Instagram media id); the id cannot be derived from the URL. Omit both to bind to the next reel.",
      });
    }
  });

type MachineUpsertInput = z.infer<typeof machineUpsertSchema>;
type Account = Extract<
  Awaited<ReturnType<typeof resolveInstagramAccountByUsername>>,
  { status: "found" }
>["account"];

function jsonError(status: number, error: string, extra?: object) {
  return NextResponse.json(
    { success: false, error, ...extra },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function POST(request: NextRequest) {
  const denied = requireMachineAuth(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "Request body must be JSON");
  }

  const parsed = machineUpsertSchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return jsonError(
      400,
      `Invalid input: ${details
        .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
        .join("; ")}`,
      { details }
    );
  }

  const resolved = await resolveInstagramAccountByUsername(
    parsed.data.instagramUsername
  );
  if (resolved.status === "not_found") {
    return jsonError(
      404,
      `Instagram account @${resolved.username} is not connected to OpenReply. Connect it in Settings, or GET /api/automations/machine/accounts to see connected accounts.`
    );
  }
  if (resolved.status === "ambiguous") {
    return jsonError(
      409,
      `${resolved.count} connected accounts are named @${resolved.username}; resolve the duplicate in Settings first.`
    );
  }

  // A concurrent call with the same key can win the create race; the unique
  // index on (instagramAccountId, externalKey) then rejects ours, and a second
  // pass finds that row and updates it instead.
  try {
    return await upsertCampaign(parsed.data, resolved.account);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return upsertCampaign(parsed.data, resolved.account);
  }
}

async function upsertCampaign(
  input: MachineUpsertInput,
  account: Account
): Promise<NextResponse> {
  const existing = await prisma.automation.findUnique({
    where: {
      instagramAccountId_externalKey: {
        instagramAccountId: account.id,
        externalKey: input.key,
      },
    },
    include: {
      trackedLinks: {
        select: { id: true, slug: true, destinationUrl: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // --- Which post fires it -------------------------------------------------
  // postId given: bind now. Omitted: wait for the next reel, unless this
  // campaign was already bound (by the attach-next-reel cron or an earlier
  // call) — re-sending the same payload must not unbind a live campaign.
  let postId: string | null;
  let postUrl: string | null;
  let pendingNextReel: boolean;
  if (input.postId) {
    postId = input.postId;
    postUrl =
      input.postUrl ??
      (existing?.postId === input.postId ? existing.postUrl : null);
    pendingNextReel = false;
  } else if (existing?.postId) {
    postId = existing.postId;
    postUrl = existing.postUrl;
    pendingNextReel = false;
  } else {
    postId = null;
    postUrl = null;
    pendingNextReel = true;
  }

  // --- Per-account collision rules ------------------------------------------
  // Meta allows ONE private reply per comment, so two campaigns answering the
  // same comment means the second always fails and still burns hourly quota.
  const otherCampaigns = {
    instagramAccountId: account.id,
    ...(existing ? { id: { not: existing.id } } : {}),
  };

  if (postId && postId !== existing?.postId) {
    // One campaign per post, the same rule the CSV import enforces and the
    // builder's post picker flags.
    const clash = await prisma.automation.findFirst({
      where: { ...otherCampaigns, postId },
      select: { id: true, name: true },
    });
    if (clash) {
      return jsonError(
        409,
        `Post ${postId} on @${account.username} already has campaign "${clash.name}" (${clash.id}). One campaign per post.`,
        { conflictingCampaignId: clash.id }
      );
    }
  }

  if (pendingNextReel && !existing?.pendingNextReel) {
    // attach-next-reel binds EVERY waiting campaign on an account to the same
    // earliest new reel, so two waiting at once would share one reel.
    const clash = await prisma.automation.findFirst({
      where: { ...otherCampaigns, pendingNextReel: true },
      select: { id: true, name: true },
    });
    if (clash) {
      return jsonError(
        409,
        `Campaign "${clash.name}" (${clash.id}) on @${account.username} is already waiting for the next reel, and both would attach to the same reel. Post that reel first (it binds within ~5 minutes), or pass postId.`,
        { conflictingCampaignId: clash.id }
      );
    }
  }

  // --- Fields ----------------------------------------------------------------
  const { keywords } = normalizeKeywords(input.keywords);
  const publicReplyList = normalizePublicReplyList(input.publicReplyMessages);
  const ownedFields = {
    postId,
    postUrl,
    pendingNextReel,
    matchAnyPost: false,
    keywords,
    matchAnyWord: false,
    wholeWordMatch: input.wholeWordMatch,
    dmMessage: input.dmMessage,
    linkButtonLabel: input.linkButtonLabel,
    ...followGateFields({
      requireFollow: input.requireFollow,
      followPromptMessage: input.followPromptMessage,
      followPromptButtonLabel: input.followPromptButtonLabel,
    }),
    ...publicReplyFields({
      enabled: publicReplyList.length > 0,
      list: publicReplyList,
    }),
  };

  const trackedLinksResult = {
    select: { slug: true },
    orderBy: { createdAt: "asc" as const },
  };

  let automation;
  if (!existing) {
    automation = await prisma.automation.create({
      data: {
        ...ownedFields,
        name: input.name ?? `reel:${input.key}`,
        goal: input.goal ?? null,
        isActive: input.isActive ?? true,
        externalKey: input.key,
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        reportShareSlug: generateReportShareSlug(),
        ...(input.linkUrl
          ? {
              trackedLinks: {
                create: [
                  buildPrimaryTrackedLinkCreate(
                    account.workspaceId,
                    input.linkUrl
                  ),
                ],
              },
            }
          : {}),
      },
      include: { trackedLinks: trackedLinksResult },
    });
  } else {
    // The primary link keeps its slug forever (DMs already sent point at it);
    // only its destination moves. Omitting linkUrl never deletes a link —
    // that would cascade away its click history and break old DMs.
    const primaryLink = existing.trackedLinks[0];
    automation = await prisma.automation.update({
      where: { id: existing.id },
      data: {
        ...ownedFields,
        // Labels and the on/off switch are only changed when sent, so a rename
        // or pause made in the dashboard survives a re-run.
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(existing.reportShareSlug
          ? {}
          : { reportShareSlug: generateReportShareSlug() }),
        ...(input.linkUrl
          ? {
              trackedLinks: primaryLink
                ? {
                    update: {
                      where: { id: primaryLink.id },
                      data: { destinationUrl: input.linkUrl },
                    },
                  }
                : {
                    create: [
                      buildPrimaryTrackedLinkCreate(
                        account.workspaceId,
                        input.linkUrl
                      ),
                    ],
                  },
            }
          : {}),
      },
      include: { trackedLinks: trackedLinksResult },
    });
  }

  // --- Non-blocking warnings -------------------------------------------------
  const warnings: string[] = [];
  const tokenProblem = await getTokenProblem(account);
  if (tokenProblem) {
    warnings.push(
      `@${account.username}'s Instagram token is ${tokenProblem}; the campaign is saved but no DM will send until the account is reconnected (reconnect, do NOT disconnect first).`
    );
  }
  // An active any-post campaign whose keywords also fire on ours answers the
  // same comment first or second; one of the two private replies will fail.
  const anyPostCampaigns = await prisma.automation.findMany({
    where: { ...otherCampaigns, isActive: true, matchAnyPost: true },
    select: {
      id: true,
      name: true,
      keywords: true,
      matchAnyWord: true,
      wholeWordMatch: true,
    },
  });
  for (const other of anyPostCampaigns) {
    const overlapping = other.matchAnyWord
      ? keywords
      : keywords.filter(
          (k) => matchKeywords(k, other.keywords, other.wholeWordMatch).matched
        );
    if (overlapping.length > 0) {
      warnings.push(
        `Active any-post campaign "${other.name}" (${other.id}) also fires on ${overlapping
          .map((k) => `"${k}"`)
          .join(", ")}; Meta allows one private reply per comment, so one of the two DMs will fail.`
      );
    }
  }

  const trackedLinkSlug = automation.trackedLinks[0]?.slug ?? null;
  return NextResponse.json(
    {
      success: true,
      data: {
        id: automation.id,
        created: !existing,
        name: automation.name,
        isActive: automation.isActive,
        pendingNextReel: automation.pendingNextReel,
        postId: automation.postId,
        trackedLinkSlug,
        trackedUrl: trackedLinkSlug ? buildTrackedUrl(trackedLinkSlug) : null,
        warnings,
      },
    },
    { status: existing ? 200 : 201, headers: { "Cache-Control": "no-store" } }
  );
}
