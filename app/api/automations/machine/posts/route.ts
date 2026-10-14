import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireMachineAuth } from "@/lib/machine-api/auth";
import {
  getTokenProblem,
  resolveInstagramAccountByUsername,
} from "@/lib/machine-api/accounts";

export const dynamic = "force-dynamic";

/**
 * /api/automations/machine/posts — the auto-post queue (bearer-key auth).
 *
 *   POST  queue or update ONE reel, identified by (account, `key`)
 *   GET   list the queue (?instagramUsername=…&status=…)
 *
 * A post starts as DRAFT; uploading its video to
 * PUT /api/automations/machine/posts/<id>/video schedules it, and
 * /api/cron/publish-scheduled publishes it at `scheduledAt`. Full reference:
 * docs/machine-api.md.
 */

// Instagram's caption limit
const MAX_CAPTION = 2200;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const postSchema = z.strictObject({
  instagramUsername: z.string().trim().min(1).max(64),
  key: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      KEY_PATTERN,
      "key may contain letters, digits, '.', '_', ':' and '-', starting with a letter or digit"
    ),
  caption: z.string().max(MAX_CAPTION),
  scheduledAt: z.iso.datetime({ offset: true }),
});

const STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "PROCESSING",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELED",
] as const;

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

const postView = {
  id: true,
  externalKey: true,
  caption: true,
  scheduledAt: true,
  status: true,
  mediaId: true,
  permalink: true,
  error: true,
  attempts: true,
  publishedAt: true,
  instagramAccount: { select: { username: true } },
  media: { select: { kind: true, size: true } },
} as const;

type PostRow = {
  id: string;
  externalKey: string;
  caption: string;
  scheduledAt: Date;
  status: string;
  mediaId: string | null;
  permalink: string | null;
  error: string | null;
  attempts: number;
  publishedAt: Date | null;
  instagramAccount: { username: string };
  media: { kind: string; size: number }[];
};

function present(post: PostRow) {
  return {
    id: post.id,
    key: post.externalKey,
    instagramUsername: post.instagramAccount.username,
    status: post.status,
    scheduledAt: post.scheduledAt.toISOString(),
    publishedAt: post.publishedAt?.toISOString() ?? null,
    permalink: post.permalink,
    mediaId: post.mediaId,
    error: post.error,
    attempts: post.attempts,
    hasVideo: post.media.some((m) => m.kind === "video"),
    hasCover: post.media.some((m) => m.kind === "cover"),
    captionLength: post.caption.length,
  };
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

  const parsed = postSchema.safeParse(body);
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

  const resolved = await resolveInstagramAccountByUsername(parsed.data.instagramUsername);
  if (resolved.status === "not_found") {
    return jsonError(
      404,
      `Instagram account @${resolved.username} is not connected to OpenReply. Connect it in Settings first.`
    );
  }
  if (resolved.status === "ambiguous") {
    return jsonError(
      409,
      `${resolved.count} connected accounts are named @${resolved.username}; resolve the duplicate in Settings first.`
    );
  }
  const account = resolved.account;
  const input = parsed.data;
  const scheduledAt = new Date(input.scheduledAt);

  const save = async () => {
    const existing = await prisma.scheduledPost.findUnique({
      where: {
        instagramAccountId_externalKey: {
          instagramAccountId: account.id,
          externalKey: input.key,
        },
      },
      select: { id: true, status: true, permalink: true, media: { select: { kind: true } } },
    });

    if (existing?.status === "PUBLISHED") {
      return jsonError(409, `"${input.key}" is already published`, {
        data: { id: existing.id, status: existing.status, permalink: existing.permalink },
      });
    }
    if (existing && (existing.status === "PROCESSING" || existing.status === "PUBLISHING")) {
      return jsonError(409, `"${input.key}" is being published right now`, {
        data: { id: existing.id, status: existing.status },
      });
    }

    // Re-sending a post (including a FAILED or CANCELED one) puts it back in
    // the queue with the new caption and time, as long as its video is there.
    const hasVideo = existing?.media.some((m) => m.kind === "video") ?? false;
    const fields = {
      caption: input.caption,
      scheduledAt,
      status: hasVideo ? ("SCHEDULED" as const) : ("DRAFT" as const),
      error: null,
      containerId: null,
      containerAt: null,
    };

    const post = existing
      ? await prisma.scheduledPost.update({
          where: { id: existing.id },
          data: { ...fields, attempts: 0 },
          select: postView,
        })
      : await prisma.scheduledPost.create({
          data: {
            ...fields,
            workspaceId: account.workspaceId,
            instagramAccountId: account.id,
            externalKey: input.key,
          },
          select: postView,
        });

    const warnings: string[] = [];
    const problem = await getTokenProblem(account);
    if (problem) {
      warnings.push(
        `@${account.username}'s token is ${problem}: reconnect it in Settings or this post will fail`
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          ...present(post),
          upload: {
            video: `/api/automations/machine/posts/${post.id}/video`,
            cover: `/api/automations/machine/posts/${post.id}/cover`,
          },
        },
        ...(warnings.length ? { warnings } : {}),
      },
      { status: existing ? 200 : 201, headers: { "Cache-Control": "no-store" } }
    );
  };

  // A concurrent call with the same key can win the create race; the unique
  // index then rejects ours, and a second pass updates that row instead.
  try {
    return await save();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return save();
  }
}

export async function GET(request: NextRequest) {
  const denied = requireMachineAuth(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const username = params.get("instagramUsername");
  const status = params.get("status");

  let instagramAccountId: string | undefined;
  if (username) {
    const resolved = await resolveInstagramAccountByUsername(username);
    if (resolved.status !== "found") {
      return jsonError(404, `Instagram account @${resolved.username} is not connected to OpenReply.`);
    }
    instagramAccountId = resolved.account.id;
  }
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    return jsonError(400, `status must be one of ${STATUSES.join(", ")}`);
  }

  const posts = await prisma.scheduledPost.findMany({
    where: {
      ...(instagramAccountId ? { instagramAccountId } : {}),
      ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
    },
    select: postView,
    orderBy: { scheduledAt: "asc" },
    take: 500,
  });

  return NextResponse.json(
    { success: true, data: posts.map(present) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
