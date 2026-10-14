import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireMachineAuth } from "@/lib/machine-api/auth";

export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ id: string }> };

/**
 * DELETE /api/automations/machine/posts/<id> — take a post out of the queue.
 * Its uploaded files are deleted; the row stays as CANCELED so re-sending the
 * same key later re-queues it. A post Instagram is already processing or has
 * published cannot be cancelled from here.
 */
export async function DELETE(request: NextRequest, { params }: RouteProps) {
  const denied = requireMachineAuth(request);
  if (denied) return denied;

  const { id } = await params;
  const cancelled = await prisma.scheduledPost.updateMany({
    where: { id, status: { in: ["DRAFT", "SCHEDULED", "FAILED"] } },
    data: { status: "CANCELED", containerId: null, containerAt: null },
  });

  if (cancelled.count === 0) {
    const post = await prisma.scheduledPost.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!post) {
      return NextResponse.json(
        { success: false, error: "Post not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (post.status !== "CANCELED") {
      return NextResponse.json(
        { success: false, error: `Post is ${post.status} and can't be cancelled` },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  await prisma.postMedia.deleteMany({ where: { postId: id } });
  return NextResponse.json(
    { success: true, data: { id, status: "CANCELED" } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
