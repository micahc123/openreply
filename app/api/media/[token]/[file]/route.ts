import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { parseRange } from "@/lib/publishing/range";

export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ token: string; file: string }> };

/**
 * GET /api/media/<token>/<file> — a queued post's video or cover, public so
 * Instagram can fetch it while publishing (it takes a URL, not an upload).
 * The token is 24 random bytes; the file name is only there so the URL ends
 * in .mp4/.jpg. Supports a single byte range, which video fetchers use.
 */

async function serve(request: NextRequest, { params }: RouteProps, withBody: boolean) {
  const { token } = await params;
  const media = await prisma.postMedia.findUnique({
    where: { token },
    select: { data: true, contentType: true, size: true },
  });
  if (!media) {
    return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const headers: Record<string, string> = {
    "Content-Type": media.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex",
  };

  const range = parseRange(request.headers.get("range"), media.size);
  if (range === "invalid") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${media.size}` },
    });
  }

  const bytes = Buffer.from(media.data);
  if (range) {
    const chunk = bytes.subarray(range.start, range.end + 1);
    return new NextResponse(withBody ? chunk : null, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${range.start}-${range.end}/${media.size}`,
      },
    });
  }

  return new NextResponse(withBody ? bytes : null, {
    status: 200,
    headers: { ...headers, "Content-Length": String(media.size) },
  });
}

export function GET(request: NextRequest, props: RouteProps) {
  return serve(request, props, true);
}

export function HEAD(request: NextRequest, props: RouteProps) {
  return serve(request, props, false);
}
