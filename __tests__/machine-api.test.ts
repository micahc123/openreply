import { beforeEach, describe, expect, it, vi } from "vitest";

type LinkRow = {
  id: string;
  automationId: string;
  workspaceId: string;
  slug: string;
  label: string | null;
  destinationUrl: string;
};
type AutomationRow = Record<string, unknown> & {
  id: string;
  instagramAccountId: string;
  externalKey: string | null;
  postId: string | null;
  pendingNextReel: boolean;
  trackedLinks: LinkRow[];
};

const { mockPrisma, mockIsTokenInvalid, db } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn() },
    automation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  mockIsTokenInvalid: vi.fn(),
  db: { automations: [] as AutomationRow[], seq: 0 },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/ops/token-health", () => ({ isTokenInvalid: mockIsTokenInvalid }));

import { GET as getAccounts } from "../app/api/automations/machine/accounts/route";
import { POST as upsert } from "../app/api/automations/machine/upsert/route";
import { NextRequest } from "next/server";
import { config as proxyConfig, proxy } from "../proxy";

const KEY = "k".repeat(40);
const BASE = "https://openreply.example.com";

const keithAccount = {
  id: "acct_keith",
  workspaceId: "ws_1",
  username: "keithai_",
  accessToken: "encrypted",
  tokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
};

function request(
  path: string,
  { body, auth = `Bearer ${KEY}`, method = "POST" }: {
    body?: unknown;
    auth?: string | null;
    method?: string;
  } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as Parameters<typeof upsert>[0];
}

const callUpsert = (body: unknown, auth?: string | null) =>
  upsert(request("/api/automations/machine/upsert", { body, auth }));
const callAccounts = (auth?: string | null) =>
  getAccounts(
    request("/api/automations/machine/accounts", { method: "GET", auth })
  );

const baseBody = {
  instagramUsername: "@KeithAI_",
  key: "ai-job-crew",
  keywords: ["guide"],
  dmMessage: "here's the guide 👇 {link}",
  linkUrl: "https://www.vividsites.app/guides/ai-job-crew",
};

// --- A tiny in-memory Automation table, enough for the route's queries ------

function matchesWhere(row: AutomationRow, where: Record<string, unknown>) {
  return Object.entries(where).every(([field, cond]) => {
    if (cond && typeof cond === "object" && "not" in cond) {
      return row[field] !== (cond as { not: unknown }).not;
    }
    return row[field] === cond;
  });
}

function withLinks(row: AutomationRow) {
  return { ...row, trackedLinks: row.trackedLinks.map((l) => ({ ...l })) };
}

function installFakeDb() {
  mockPrisma.automation.findUnique.mockImplementation(
    async ({ where }: { where: Record<string, { instagramAccountId: string; externalKey: string }> }) => {
      const k = where.instagramAccountId_externalKey;
      const row = db.automations.find(
        (a) =>
          a.instagramAccountId === k.instagramAccountId &&
          a.externalKey === k.externalKey
      );
      return row ? withLinks(row) : null;
    }
  );
  mockPrisma.automation.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      db.automations.find((a) => matchesWhere(a, where)) ?? null
  );
  mockPrisma.automation.findMany.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      db.automations.filter((a) => matchesWhere(a, where))
  );
  mockPrisma.automation.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      const { trackedLinks, ...rest } = data as {
        trackedLinks?: { create: Omit<LinkRow, "id" | "automationId">[] };
      };
      const id = `auto_${++db.seq}`;
      const row = {
        ...rest,
        id,
        trackedLinks: (trackedLinks?.create ?? []).map((l, i) => ({
          ...l,
          id: `link_${db.seq}_${i}`,
          automationId: id,
        })),
      } as AutomationRow;
      db.automations.push(row);
      return withLinks(row);
    }
  );
  mockPrisma.automation.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = db.automations.find((a) => a.id === where.id);
      if (!row) throw new Error("not found");
      const { trackedLinks, ...rest } = data as {
        trackedLinks?: {
          update?: { where: { id: string }; data: Partial<LinkRow> };
          create?: Omit<LinkRow, "id" | "automationId">[];
        };
      };
      Object.assign(row, rest);
      if (trackedLinks?.update) {
        const link = row.trackedLinks.find(
          (l) => l.id === trackedLinks.update!.where.id
        );
        Object.assign(link!, trackedLinks.update.data);
      }
      for (const l of trackedLinks?.create ?? []) {
        row.trackedLinks.push({ ...l, id: `link_x_${row.trackedLinks.length}`, automationId: row.id });
      }
      return withLinks(row);
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("AUTOMATION_API_KEY", KEY);
  vi.stubEnv("NEXTAUTH_URL", BASE);
  vi.stubEnv("DISABLE_LINK_TRACKING", "");
  db.automations = [];
  db.seq = 0;
  installFakeDb();
  mockIsTokenInvalid.mockResolvedValue(false);
  mockPrisma.instagramAccount.findMany.mockResolvedValue([keithAccount]);
});

describe("machine API auth", () => {
  it("is disabled (503) when AUTOMATION_API_KEY is unset", async () => {
    vi.stubEnv("AUTOMATION_API_KEY", "");
    const res = await callUpsert(baseBody);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/AUTOMATION_API_KEY is not set/);
    expect((await callAccounts()).status).toBe(503);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("stays disabled when the key is too short to trust", async () => {
    vi.stubEnv("AUTOMATION_API_KEY", "short-key");
    const res = await callAccounts("Bearer short-key");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/at least 32 characters/);
  });

  it("rejects a missing Authorization header with 401", async () => {
    const res = await callUpsert(baseBody, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(mockPrisma.instagramAccount.findMany).not.toHaveBeenCalled();
  });

  it("rejects a wrong key, a near-miss, and a non-bearer scheme with 401", async () => {
    for (const auth of [
      "Bearer wrong",
      `Bearer ${KEY.slice(0, -1)}`,
      `Bearer ${KEY}x`,
      `Basic ${KEY}`,
      KEY,
    ]) {
      expect((await callUpsert(baseBody, auth)).status).toBe(401);
      expect((await callAccounts(auth)).status).toBe(401);
    }
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("is not redirected to /login by the proxy (no session cookie needed)", () => {
    // The matcher decides whether the proxy runs at all; it must not cover /api.
    expect(proxyConfig.matcher.some((m) => m.startsWith("/api"))).toBe(false);
    for (const path of [
      "/api/automations/machine/accounts",
      "/api/automations/machine/upsert",
    ]) {
      const res = proxy(new NextRequest(`${BASE}${path}`));
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });
});

describe("GET /api/automations/machine/accounts", () => {
  it("lists accounts with token health and never returns the token", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { ...keithAccount, instagramId: "ig_1", name: "Keith", connectedAt: new Date() },
      {
        ...keithAccount,
        id: "acct_old",
        username: "expired_one",
        instagramId: "ig_2",
        name: null,
        connectedAt: new Date(),
        tokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        ...keithAccount,
        id: "acct_dead",
        username: "dead_one",
        instagramId: "ig_3",
        name: null,
        connectedAt: new Date(),
      },
    ]);
    mockIsTokenInvalid.mockImplementation(async (id: string) => id === "acct_dead");

    const res = await callAccounts();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      expect.objectContaining({ id: "acct_keith", username: "keithai_", workspaceId: "ws_1", tokenOk: true, tokenProblem: null }),
      expect.objectContaining({ id: "acct_old", tokenOk: false, tokenProblem: "expired" }),
      expect.objectContaining({ id: "acct_dead", tokenOk: false, tokenProblem: "invalid" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("encrypted");
  });
});

describe("POST /api/automations/machine/upsert", () => {
  it("resolves the username case-insensitively with the @ stripped", async () => {
    await callUpsert(baseBody);
    expect(mockPrisma.instagramAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: { equals: "KeithAI_", mode: "insensitive" } },
      })
    );
  });

  it("404s with a clear error when the account is not connected", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([]);
    const res = await callUpsert({ ...baseBody, instagramUsername: "@nobody" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/@nobody is not connected/);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("requires {link} in dmMessage when linkUrl is set", async () => {
    const res = await callUpsert({ ...baseBody, dmMessage: "here's the guide" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/dmMessage: dmMessage must contain \{link\}/);
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("rejects {link} with no linkUrl (it would be sent as literal text)", async () => {
    const res = await callUpsert({ ...baseBody, linkUrl: undefined });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no linkUrl was given/);
  });

  it("rejects a raw URL in dmMessage (Meta error 508) and a non-https linkUrl", async () => {
    const raw = await callUpsert({
      ...baseBody,
      dmMessage: "{link} or go to https://www.vividsites.app",
    });
    expect(raw.status).toBe(400);
    expect((await raw.json()).error).toMatch(/raw URL/);

    const http = await callUpsert({ ...baseBody, linkUrl: "http://vividsites.app" });
    expect(http.status).toBe(400);
    expect((await http.json()).error).toMatch(/https/);
  });

  it("rejects unknown fields so a typo cannot silently drop a setting", async () => {
    const res = await callUpsert({ ...baseBody, linkurl: "https://x.example" });
    expect(res.status).toBe(400);
  });

  it("rejects keywords that could never match and dedupes the rest", async () => {
    const bad = await callUpsert({ ...baseBody, keywords: ["guide", "🔥🔥"] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/can never match/);

    await callUpsert({ ...baseBody, keywords: ["Guide", "guide!", " GUIDE ", "prompt"] });
    expect(db.automations[0].keywords).toEqual(["Guide", "prompt"]);
  });

  it("creates a campaign waiting for the next reel when no postId is given", async () => {
    const res = await callUpsert(baseBody);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({
      created: true,
      pendingNextReel: true,
      postId: null,
      isActive: true,
      name: "reel:ai-job-crew",
      warnings: [],
    });
    expect(data.trackedLinkSlug).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(data.trackedUrl).toBe(`${BASE}/r/${data.trackedLinkSlug}`);

    const createData = mockPrisma.automation.create.mock.calls[0][0].data;
    expect(createData).toMatchObject({
      externalKey: "ai-job-crew",
      workspaceId: "ws_1",
      instagramAccountId: "acct_keith",
      pendingNextReel: true,
      postId: null,
      matchAnyPost: false,
      matchAnyWord: false,
      keywords: ["guide"],
      wholeWordMatch: true,
      dmMessage: "here's the guide 👇 {link}",
      linkButtonLabel: "Get the guide",
      requireFollow: false,
      followPromptMessage: null,
      followPromptButtonLabel: null,
      publicReplyEnabled: false,
      publicReplyMessages: [],
      publicReplyMessage: null,
      reportShareSlug: expect.any(String),
      trackedLinks: {
        create: [
          expect.objectContaining({
            workspaceId: "ws_1",
            label: "Primary campaign link",
            destinationUrl: "https://www.vividsites.app/guides/ai-job-crew",
          }),
        ],
      },
    });
  });

  it("binds directly to a post when postId is given", async () => {
    const res = await callUpsert({
      ...baseBody,
      postId: "17900000000000001",
      postUrl: "https://www.instagram.com/reel/ABC123/",
    });
    const { data } = await res.json();
    expect(data).toMatchObject({ pendingNextReel: false, postId: "17900000000000001" });
    expect(db.automations[0].postUrl).toBe("https://www.instagram.com/reel/ABC123/");
  });

  it("is idempotent: the same key twice updates ONE campaign and keeps the link slug", async () => {
    const first = await (await callUpsert(baseBody)).json();

    const second = await callUpsert({
      ...baseBody,
      dmMessage: "fresh copy, same reel {link}",
      linkUrl: "https://www.vividsites.app/guides/ai-job-crew-v2",
      linkButtonLabel: "Open the guide",
      publicReplyMessages: ["sent 📩", "  ", "check your DMs"],
    });
    expect(second.status).toBe(200);
    const { data } = await second.json();

    expect(data.created).toBe(false);
    expect(data.id).toBe(first.data.id);
    expect(data.trackedLinkSlug).toBe(first.data.trackedLinkSlug);
    expect(mockPrisma.automation.create).toHaveBeenCalledTimes(1);
    expect(db.automations).toHaveLength(1);

    const row = db.automations[0];
    expect(row.trackedLinks).toHaveLength(1);
    expect(row.trackedLinks[0].destinationUrl).toBe(
      "https://www.vividsites.app/guides/ai-job-crew-v2"
    );
    expect(row).toMatchObject({
      dmMessage: "fresh copy, same reel {link}",
      linkButtonLabel: "Open the guide",
      publicReplyEnabled: true,
      publicReplyMessages: ["sent 📩", "check your DMs"],
      publicReplyMessage: "sent 📩",
    });
  });

  it("keeps a campaign the cron already bound when re-sent without postId", async () => {
    await callUpsert(baseBody);
    // attach-next-reel binds it to the reel that was just posted.
    Object.assign(db.automations[0], { postId: "17900000000000009", pendingNextReel: false });

    const { data } = await (await callUpsert(baseBody)).json();
    expect(data).toMatchObject({ pendingNextReel: false, postId: "17900000000000009" });
  });

  it("leaves name, goal and a dashboard pause alone on re-run unless sent", async () => {
    await callUpsert({ ...baseBody, goal: "guide signups" });
    Object.assign(db.automations[0], { name: "Renamed in dashboard", isActive: false });

    const { data } = await (await callUpsert(baseBody)).json();
    expect(data).toMatchObject({ name: "Renamed in dashboard", isActive: false });
    expect(db.automations[0].goal).toBe("guide signups");

    const resumed = await (await callUpsert({ ...baseBody, isActive: true })).json();
    expect(resumed.data.isActive).toBe(true);
  });

  it("refuses a second campaign waiting for the next reel on the same account", async () => {
    await callUpsert(baseBody);
    const res = await callUpsert({ ...baseBody, key: "another-reel" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already waiting for the next reel/);
    expect(db.automations).toHaveLength(1);
  });

  it("matchAnyPost: fires on any post, never waits for a reel, and many can coexist", async () => {
    const res = await callUpsert({ ...baseBody, matchAnyPost: true });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ pendingNextReel: false, postId: null });
    expect(mockPrisma.automation.create.mock.calls[0][0].data).toMatchObject({ matchAnyPost: true, pendingNextReel: false, postId: null });
    // a second any-post campaign with its own word is fine: no 409, no "already waiting"
    const res2 = await callUpsert({ ...baseBody, key: "another-reel", keywords: ["local"], matchAnyPost: true });
    expect(res2.status).toBe(201);
    expect(db.automations).toHaveLength(2);
  });

  it("matchAnyPost moves an existing next-reel campaign onto every post", async () => {
    await callUpsert(baseBody);
    const res = await callUpsert({ ...baseBody, matchAnyPost: true });
    expect(res.status).toBe(200);
    expect(db.automations).toHaveLength(1);
    expect(db.automations[0]).toMatchObject({ matchAnyPost: true, pendingNextReel: false, postId: null });
  });

  it("rejects matchAnyPost together with postId", async () => {
    const res = await callUpsert({ ...baseBody, matchAnyPost: true, postId: "17900000000000001" });
    expect(res.status).toBe(400);
  });

  it("refuses a post that another campaign already uses", async () => {
    await callUpsert({ ...baseBody, postId: "17900000000000001" });
    const res = await callUpsert({ ...baseBody, key: "other", postId: "17900000000000001" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/One campaign per post/);
  });

  it("warns (without blocking) when an any-post campaign shares a keyword", async () => {
    db.automations.push({
      id: "auto_anypost",
      name: "free",
      instagramAccountId: "acct_keith",
      externalKey: null,
      postId: null,
      pendingNextReel: false,
      matchAnyPost: true,
      isActive: true,
      keywords: ["GUIDE"],
      matchAnyWord: false,
      wholeWordMatch: true,
      trackedLinks: [],
    });
    const res = await callUpsert(baseBody);
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.warnings).toEqual([expect.stringMatching(/"free".*"guide"/)]);
  });

  it("warns when the account token is known-dead", async () => {
    mockIsTokenInvalid.mockResolvedValue(true);
    const { data } = await (await callUpsert(baseBody)).json();
    expect(data.warnings[0]).toMatch(/token is invalid/);
  });

  it("recovers from a concurrent create with the same key by updating", async () => {
    // Another request creates the row between our lookup and our create.
    mockPrisma.automation.create.mockImplementationOnce(async () => {
      db.automations.push({
        id: "auto_racer",
        instagramAccountId: "acct_keith",
        externalKey: "ai-job-crew",
        postId: null,
        pendingNextReel: true,
        reportShareSlug: "r1",
        trackedLinks: [
          { id: "link_racer", automationId: "auto_racer", workspaceId: "ws_1", slug: "racerslug", label: "Primary campaign link", destinationUrl: "https://x.example" },
        ],
      });
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });

    const res = await callUpsert(baseBody);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ id: "auto_racer", created: false, trackedLinkSlug: "racerslug" });
    expect(db.automations).toHaveLength(1);
  });
});
