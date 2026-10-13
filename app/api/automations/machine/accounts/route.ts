import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireMachineAuth } from "@/lib/machine-api/auth";
import { getTokenProblem } from "@/lib/machine-api/accounts";

// Live token state; never cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/automations/machine/accounts
 *
 * Every connected Instagram account, for a script that needs to know which
 * `instagramUsername` values the upsert route will accept. Bearer-key auth
 * (AUTOMATION_API_KEY); see docs/machine-api.md. Never returns the token.
 */
export async function GET(request: NextRequest) {
  const denied = requireMachineAuth(request);
  if (denied) return denied;

  const accounts = await prisma.instagramAccount.findMany({
    select: {
      id: true,
      instagramId: true,
      username: true,
      name: true,
      workspaceId: true,
      accessToken: true,
      tokenExpiresAt: true,
      connectedAt: true,
    },
    orderBy: { connectedAt: "asc" },
  });

  const now = new Date();
  const data = await Promise.all(
    accounts.map(async (account) => {
      const tokenProblem = await getTokenProblem(account, now);
      return {
        id: account.id,
        instagramId: account.instagramId,
        username: account.username,
        name: account.name,
        workspaceId: account.workspaceId,
        tokenOk: tokenProblem === null,
        tokenProblem,
        tokenExpiresAt: account.tokenExpiresAt,
        connectedAt: account.connectedAt,
      };
    })
  );

  return NextResponse.json(
    { success: true, data },
    { headers: { "Cache-Control": "no-store" } }
  );
}
