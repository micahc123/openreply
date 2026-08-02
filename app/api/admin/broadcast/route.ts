import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { sendDirectMessage } from "@/lib/meta/client";
import { renderMessageWithoutLink } from "@/lib/tracking/message";

/**
 * One-off broadcast to contacts inside Meta's 24-hour messaging window.
 *
 * Meta only permits messaging a user within 24 hours of that user messaging
 * the business. A comment does NOT open that window — only an actual message
 * does, which in this app means tapping a DM button. Contacts outside the
 * window are unreachable: the send is rejected, so there is no "message
 * everyone" capability to build.
 *
 * This route therefore selects exactly the reachable set: distinct users with
 * a recorded button tap in the last `windowHours` (default 24). Everyone else
 * is excluded rather than attempted, because failed sends still consume API
 * quota and volumes of rejected sends are what get accounts restricted.
 *
 * These are Send API messages, not private replies, so they draw on a
 * different quota than the 600/hour comment-reply cap and cannot starve the
 * live comment funnel.
 *
 * Auth: Bearer CRON_SECRET. POST { message, dryRun?, windowHours?, limit? }.
 * Always dry-run first — it returns the exact recipient count without sending.
 */

export const runtime = "nodejs";
export const maxDuration = 800;

/** Send API allows far more, but a steady trickle looks less like a blast. */
const DELAY_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => null);
  const message: string | undefined = body?.message;
  const dryRun: boolean = body?.dryRun !== false; // default to dry run
  const windowHours: number = Number(body?.windowHours ?? 24);
  const limit: number = Number(body?.limit ?? 1000);

  if (!message || !message.trim()) {
    return NextResponse.json(
      { success: false, error: "message is required" },
      { status: 400 }
    );
  }

  const account = await prisma.instagramAccount.findFirst();
  if (!account?.accessToken) {
    return NextResponse.json(
      { success: false, error: "No connected Instagram account" },
      { status: 400 }
    );
  }

  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // One row per person: the most recent tap, so we message each contact once.
  const taps = await prisma.dmLog.findMany({
    where: { commentText: "(button tap)", updatedAt: { gte: since } },
    select: { commenterId: true, commenterName: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });

  const seen = new Set<string>();
  const recipients: { id: string; name: string | null }[] = [];
  for (const t of taps) {
    if (seen.has(t.commenterId)) continue;
    seen.add(t.commenterId);
    recipients.push({ id: t.commenterId, name: t.commenterName });
    if (recipients.length >= limit) break;
  }

  if (dryRun) {
    return NextResponse.json({
      success: true,
      dryRun: true,
      windowHours,
      recipients: recipients.length,
      sample: recipients.slice(0, 5).map((r) => r.name ?? r.id),
      messagePreview: message,
    });
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch {
    return NextResponse.json(
      { success: false, error: "Failed to decrypt access token" },
      { status: 500 }
    );
  }

  let sent = 0;
  let failed = 0;
  const errors: Record<string, number> = {};

  for (const r of recipients) {
    try {
      await sendDirectMessage(
        accessToken,
        account.instagramId,
        r.id,
        renderMessageWithoutLink({ message, commenterName: r.name })
      );
      sent++;
    } catch (error) {
      failed++;
      const key = error instanceof Error ? error.message : "Unknown error";
      errors[key] = (errors[key] ?? 0) + 1;
    }
    await sleep(DELAY_MS);
  }

  return NextResponse.json({
    success: true,
    dryRun: false,
    attempted: recipients.length,
    sent,
    failed,
    errors,
  });
}
