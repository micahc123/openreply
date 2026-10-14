import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireMachineAuth } from "@/lib/machine-api/auth";

export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ id: string; kind: string }> };

/**
 * PUT /api/automations/machine/posts/<id>/video   (Content-Type: video/mp4)
 * PUT /api/automations/machine/posts/<id>/cover   (Content-Type: image/jpeg)
 *
 * The raw file is the request body. Uploading the video moves a DRAFT (or a
 * FAILED / CANCELED post being retried) to SCHEDULED. Instagram later fetches
 * the file from /api/media/<token>/…; it is deleted once the post is live.
 */

const KINDS = {
  // Instagram's Reels limit is 300 MB; a 30–90 s reel is 10–60 MB. The cap
  // keeps the queue's footprint in Postgres sane.
  video: { types: ["video/mp4", "video/quicktime"], maxBytes: 150 * 1024 * 1024 },
  // Instagram wants a JPEG cover, 8 MB at most.
  cover: { types: ["image/jpeg"], maxBytes: 8 * 1024 * 1024 },
} as const;

function jsonError(status: number, error: string) {
  return NextResponse.json(
    { success: false, error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function PUT(request: NextRequest, { params }: RouteProps) {
  const denied = requireMachineAuth(request);
  if (denied) return denied;

  const { id, kind } = await params;
  if (kind !== "video" && kind !== "cover") {
    return jsonError(404, "Upload a 'video' or a 'cover'");
  }
  const rules = KINDS[kind];

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!(rules.types as readonly string[]).includes(contentType)) {
    return jsonError(415, `A ${kind} must be sent as ${rules.types.join(" or ")}`);
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > rules.maxBytes) {
    return jsonError(413, `A ${kind} can be at most ${rules.maxBytes / 1024 / 1024} MB`);
  }

  const post = await prisma.scheduledPost.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!post) return jsonError(404, "Post not found");
  if (post.status === "PROCESSING" || post.status === "PUBLISHING" || post.status === "PUBLISHED") {
    return jsonError(409, `Post is ${post.status}; its files can't change now`);
  }

  const data = Buffer.from(await request.arrayBuffer());
  if (data.length === 0) return jsonError(400, "Empty body");
  if (data.length > rules.maxBytes) {
    return jsonError(413, `A ${kind} can be at most ${rules.maxBytes / 1024 / 1024} MB`);
  }

  // A fresh token on every upload: a URL Instagram already fetched never
  // starts serving different bytes.
  const token = randomBytes(24).toString("base64url");
  await prisma.postMedia.upsert({
    where: { postId_kind: { postId: id, kind } },
    create: { postId: id, kind, token, contentType, size: data.length, data },
    update: { token, contentType, size: data.length, data },
  });

  let status = post.status;
  if (kind === "video" && status !== "SCHEDULED") {
    await prisma.scheduledPost.update({
      where: { id },
      data: { status: "SCHEDULED", error: null, attempts: 0, containerId: null, containerAt: null },
    });
    status = "SCHEDULED";
  }

  return NextResponse.json(
    { success: true, data: { id, kind, size: data.length, status } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
