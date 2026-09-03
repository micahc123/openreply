import { describe, it, expect, vi, beforeEach } from "vitest";

const { store, mockGet, mockSet, mockDel, mockKeys, mockCreate } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    mockGet: vi.fn(async (k: string) => store.get(k) ?? null),
    mockSet: vi.fn(async (k: string, v: string, ..._a: unknown[]) => {
      const nx = _a.includes("NX");
      if (nx && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    mockDel: vi.fn(async (k: string) => store.delete(k)),
    mockKeys: vi.fn(async (p: string) =>
      [...store.keys()].filter((k) => k.startsWith(p.replace("*", "")))
    ),
    mockCreate: vi.fn(async () => ({})),
  };
});

vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({ get: mockGet, set: mockSet, del: mockDel, keys: mockKeys }),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: { operationalEvent: { create: mockCreate } },
}));

import {
  recordTokenInvalid,
  clearTokenInvalid,
  getInvalidTokens,
} from "../lib/ops/token-health";

const acct = {
  instagramAccountId: "acct_1",
  username: "keithai_",
  workspaceId: "ws_1",
  message: "Error validating access token",
};

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("dead-token detection", () => {
  it("marks the account so health can report it", async () => {
    await recordTokenInvalid(acct);
    const invalid = await getInvalidTokens();
    expect(invalid).toHaveLength(1);
    expect(invalid[0].username).toBe("keithai_");
  });

  // 578 failed sends must not become 578 identical log rows.
  it("logs one operational event per account, not one per failed send", async () => {
    await recordTokenInvalid(acct);
    await recordTokenInvalid(acct);
    await recordTokenInvalid(acct);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // The alert should say how long it has been broken, not when it last retried.
  it("keeps the original failure time across repeats", async () => {
    await recordTokenInvalid(acct);
    const first = (await getInvalidTokens())[0].since;
    await new Promise((r) => setTimeout(r, 5));
    await recordTokenInvalid(acct);
    expect((await getInvalidTokens())[0].since).toBe(first);
  });

  it("clears on recovery so health does not stay degraded", async () => {
    await recordTokenInvalid(acct);
    expect(await getInvalidTokens()).toHaveLength(1);
    await clearTokenInvalid("acct_1");
    expect(await getInvalidTokens()).toHaveLength(0);
  });

  it("never throws if Redis is unavailable", async () => {
    mockSet.mockRejectedValueOnce(new Error("redis down"));
    await expect(recordTokenInvalid(acct)).resolves.toBeUndefined();
  });
});
