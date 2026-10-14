import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { decryptToken } from "@/lib/meta/oauth";
import {
  createReelContainer,
  getContainerStatus,
  getMediaPermalink,
  MetaApiError,
  PermissionError,
  RateLimitError,
  publishContainer,
} from "@/lib/meta/client";

/**
 * Publishes ScheduledPosts. Driven once a minute by /api/cron/publish-scheduled
 * (pinged by the worker), and safe to run twice at once: every status change
 * that leads to a Meta call is claimed with a guarded updateMany first.
 *
 *   SCHEDULED ──(scheduledAt passed)──▶ PROCESSING: container created from the
 *     public video URL; Instagram fetches and processes it (≈30–90 s)
 *   PROCESSING ──(status FINISHED)──▶ PUBLISHING ──▶ PUBLISHED: media_publish,
 *     the uploaded files are deleted, and the campaign keyed to the same reel
 *     is bound to the new post
 *   any Meta error ──▶ FAILED with the reason. Re-sending the post through the
 *     machine API puts it back in the queue.
 *
 * Creating a container never makes anything public, so it is retried freely.
 * media_publish is the one irreversible call, so it runs at most once per claim.
 */

// Instagram's own guidance is to poll once a minute for up to five minutes;
// longer reels can take more, so allow a generous margin before giving up.
const CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;
// A PROCESSING row with no container means the run that claimed it died
// before Meta answered. After this long it goes back in the queue.
const STALE_CLAIM_MS = 5 * 60 * 1000;
const MAX_PER_RUN = 5;
// Network blips and rate limits put a post back in the queue this many times
// before it is marked FAILED.
const MAX_ATTEMPTS = 3;

const PUBLISH_PERMISSION_HINT =
  " — reconnect the account in OpenReply (Settings → reconnect, never disconnect) so it grants instagram_business_content_publish";

export function mediaFileUrl(token: string, kind: string): string {
  return `${getBaseUrl()}/api/media/${token}/${kind === "cover" ? "cover.jpg" : "reel.mp4"}`;
}

export interface PublishRunResult {
  started: number;
  published: number;
  failed: number;
  waiting: number;
}

type DuePost = Awaited<ReturnType<typeof findDuePosts>>[number];

function findDuePosts(now: Date) {
  return prisma.scheduledPost.findMany({
    where: {
      OR: [
        { status: "SCHEDULED", scheduledAt: { lte: now } },
        { status: "PROCESSING" },
      ],
    },
    include: {
      instagramAccount: {
        select: { id: true, instagramId: true, accessToken: true },
      },
      media: { select: { kind: true, token: true } },
    },
    orderBy: { scheduledAt: "asc" },
    take: MAX_PER_RUN,
  });
}

/** A failure worth retrying on the next run: no answer, a 5xx, a rate limit. */
function isTransient(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof MetaApiError) return error.code >= 500 || error.code === 1 || error.code === 2;
  return true;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof PermissionError ? message + PUBLISH_PERMISSION_HINT : message;
}

async function fail(postId: string, error: string) {
  await prisma.scheduledPost.update({
    where: { id: postId },
    data: { status: "FAILED", error: error.slice(0, 2000) },
  });
}

export async function publishDuePosts(now: Date = new Date()): Promise<PublishRunResult> {
  const result: PublishRunResult = { started: 0, published: 0, failed: 0, waiting: 0 };
  const due = await findDuePosts(now);

  for (const post of due) {
    try {
      const outcome =
        post.status === "SCHEDULED" ? await startPost(post, now) : await advancePost(post, now);
      result[outcome] += 1;
    } catch (error) {
      console.error("[publisher] post failed", post.id, error);
      await fail(post.id, describeError(error));
      result.failed += 1;
    }
  }

  return result;
}

async function startPost(post: DuePost, now: Date): Promise<keyof PublishRunResult> {
  const attempt = post.attempts + 1;
  const claimed = await prisma.scheduledPost.updateMany({
    where: { id: post.id, status: "SCHEDULED" },
    data: {
      status: "PROCESSING",
      containerId: null,
      containerAt: now,
      error: null,
      attempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) return "waiting";

  const video = post.media.find((m) => m.kind === "video");
  if (!video) {
    await fail(post.id, "No video uploaded");
    return "failed";
  }
  const cover = post.media.find((m) => m.kind === "cover");

  const token = decryptToken(post.instagramAccount.accessToken);
  let containerId: string;
  try {
    containerId = await createReelContainer(token, post.instagramAccount.instagramId, {
      videoUrl: mediaFileUrl(video.token, "video"),
      caption: post.caption,
      coverUrl: cover ? mediaFileUrl(cover.token, "cover") : undefined,
    });
  } catch (error) {
    if (isTransient(error) && attempt < MAX_ATTEMPTS) {
      console.error("[publisher] container create failed, will retry", post.id, error);
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "SCHEDULED", error: describeError(error).slice(0, 2000) },
      });
      return "waiting";
    }
    throw error;
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { containerId, containerAt: now },
  });
  return "started";
}

async function advancePost(post: DuePost, now: Date): Promise<keyof PublishRunResult> {
  const since = post.containerAt ? now.getTime() - post.containerAt.getTime() : Infinity;

  if (!post.containerId) {
    if (since > STALE_CLAIM_MS) {
      await prisma.scheduledPost.updateMany({
        where: { id: post.id, status: "PROCESSING", containerId: null },
        data: { status: "SCHEDULED" },
      });
    }
    return "waiting";
  }

  const token = decryptToken(post.instagramAccount.accessToken);
  let statusCode: string;
  let status: string | undefined;
  try {
    ({ statusCode, status } = await getContainerStatus(token, post.containerId));
  } catch (error) {
    // A blip while polling: ask again next run; the timeout below still applies.
    if (isTransient(error) && since <= CONTAINER_TIMEOUT_MS) {
      console.error("[publisher] status check failed, will retry", post.id, error);
      return "waiting";
    }
    throw error;
  }

  if (statusCode === "IN_PROGRESS") {
    if (since > CONTAINER_TIMEOUT_MS) {
      await fail(post.id, `Instagram was still processing the video after ${CONTAINER_TIMEOUT_MS / 60000} minutes`);
      return "failed";
    }
    return "waiting";
  }

  if (statusCode === "ERROR" || statusCode === "EXPIRED") {
    await fail(post.id, `Instagram could not process the video (${statusCode}${status ? `: ${status}` : ""})`);
    return "failed";
  }

  // FINISHED (or PUBLISHED, if a previous run published but died before
  // recording it, which media_publish will report as an error rather than
  // posting twice)
  const claimed = await prisma.scheduledPost.updateMany({
    where: { id: post.id, status: "PROCESSING" },
    data: { status: "PUBLISHING" },
  });
  if (claimed.count === 0) return "waiting";

  let mediaId: string;
  try {
    mediaId = await publishContainer(token, post.instagramAccount.instagramId, post.containerId);
  } catch (error) {
    await fail(
      post.id,
      `media_publish failed: ${describeError(error)}. Check the account before re-sending: it may have posted.`
    );
    return "failed";
  }

  let permalink: string | null = null;
  try {
    permalink = await getMediaPermalink(token, mediaId);
  } catch (error) {
    console.error("[publisher] permalink lookup failed", post.id, error);
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "PUBLISHED", mediaId, permalink, publishedAt: now, error: null },
  });
  await prisma.postMedia.deleteMany({ where: { postId: post.id } });

  // The reel's own campaign (same key, from /machine/upsert) goes live on this
  // exact post rather than waiting for attach-next-reel to guess it.
  await prisma.automation.updateMany({
    where: {
      instagramAccountId: post.instagramAccountId,
      externalKey: post.externalKey,
      pendingNextReel: true,
    },
    data: { postId: mediaId, postUrl: permalink, pendingNextReel: false },
  });

  return "published";
}
