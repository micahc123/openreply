import { prisma } from "@/lib/db/client";
import { isTokenInvalid } from "@/lib/ops/token-health";

export type TokenProblem = "missing" | "expired" | "invalid";

/**
 * Why this account cannot send right now, or null when it can.
 *
 * "invalid" is the Redis marker the worker sets on a Meta 190 (password change,
 * security action). It outlives a still-future tokenExpiresAt, which is why
 * expiry alone is not enough to call a token healthy.
 */
export async function getTokenProblem(
  account: { id: string; accessToken: string; tokenExpiresAt: Date | null },
  now: Date = new Date()
): Promise<TokenProblem | null> {
  if (!account.accessToken) return "missing";
  if (account.tokenExpiresAt && account.tokenExpiresAt <= now) return "expired";
  if (await isTokenInvalid(account.id)) return "invalid";
  return null;
}

/** "@KeithAI_ " → "KeithAI_" */
export function normalizeInstagramUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim();
}

export type ResolvedAccount =
  | {
      status: "found";
      account: {
        id: string;
        workspaceId: string;
        username: string;
        accessToken: string;
        tokenExpiresAt: Date | null;
      };
    }
  | { status: "not_found"; username: string }
  | { status: "ambiguous"; username: string; count: number };

/**
 * Find the connected account for a username, case-insensitively. Usernames are
 * not unique in the table (instagramId is), so two rows can share one if an
 * account was renamed or connected to two workspaces; that is reported rather
 * than guessed.
 */
export async function resolveInstagramAccountByUsername(
  raw: string
): Promise<ResolvedAccount> {
  const username = normalizeInstagramUsername(raw);
  if (!username) return { status: "not_found", username };

  const matches = await prisma.instagramAccount.findMany({
    where: { username: { equals: username, mode: "insensitive" } },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      accessToken: true,
      tokenExpiresAt: true,
    },
    take: 2,
  });

  if (matches.length === 0) return { status: "not_found", username };
  if (matches.length > 1) {
    return { status: "ambiguous", username, count: matches.length };
  }
  return { status: "found", account: matches[0] };
}
