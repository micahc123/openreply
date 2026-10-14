import { NextRequest, NextResponse } from "next/server";
import { publishDuePosts } from "@/lib/publishing/publisher";

/**
 * Publishes queued reels whose time has come and advances the ones Instagram
 * is still processing (lib/publishing/publisher.ts). Pinged every minute by the
 * always-on worker (worker/dm-worker.ts, lib/ops/cron-ping.ts); idempotent.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const data = await publishDuePosts();
  return NextResponse.json({ success: true, data });
}
