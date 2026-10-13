import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getAutomationApiKeyState } from "@/lib/env";

/**
 * Bearer-key guard for the machine API (/api/automations/machine/*).
 *
 * These routes have no browser session: a script authenticates with
 * `Authorization: Bearer <AUTOMATION_API_KEY>`. With the variable unset (or too
 * short to trust) every route answers 503, so deploying this code changes
 * nothing until someone opts in.
 *
 * Returns a ready-to-send error response, or null when the caller is allowed.
 */
export function requireMachineAuth(request: Request): NextResponse | null {
  const state = getAutomationApiKeyState();
  if (state.status === "disabled") {
    return NextResponse.json(
      { success: false, error: state.reason },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  const presented = parseBearer(request.headers.get("authorization"));
  if (presented === null || !constantTimeEqual(presented, state.key)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Bearer realm="openreply-machine-api"',
        },
      }
    );
  }

  return null;
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Compare two secrets without leaking, through timing, how much of the
 * presented value matched or how long the real key is. Hashing first gives
 * both sides the same length, which timingSafeEqual requires.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
