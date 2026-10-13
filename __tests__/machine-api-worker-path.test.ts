/**
 * A campaign created by the machine API must behave exactly like the same
 * campaign built in the dashboard. Production learned why the path matters:
 * a DM whose link travels as plain text is rejected by Meta (error 508); it is
 * only accepted inside a web_url button template, which the worker uses
 * whenever the campaign has a tracked link.
 *
 * So: create the same campaign through both routes, store what each route
 * wrote, run both rows through the real DM worker (real keyword matcher, real
 * message rendering), and require identical calls to Meta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
} = vi.hoisted(() => ({
  mockPrisma: {
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    automation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    operationalEvent: { create: vi.fn() },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

// Deterministic slugs so both campaigns render byte-identical buttons.
vi.mock("@/lib/tracking/server", () => ({
  generateTrackedLinkSlug: () => "slug_fixed",
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => ({
    userId: "user_1",
    workspaceId: "ws_1",
    role: "OWNER",
  })),
  canManageWorkspace: () => true,
}));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn() }));

vi.mock("@/lib/ops/token-health", () => ({
  isTokenInvalid: vi.fn(async () => false),
  clearTokenInvalid: vi.fn(),
  recordTokenInvalid: vi.fn(),
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  sendDirectMessageWithButton: vi.fn(),
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithLinkButton: vi.fn(),
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {},
  TokenExpiredError: class TokenExpiredError extends Error {},
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "plain_token" }));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: vi.fn(async () => ({
    allowed: true,
    periodStart: new Date(),
    limit: 0,
  })),
  releaseWorkspaceDMReservation: vi.fn(),
}));
vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: vi.fn() }),
  getRedisConnection: vi.fn(),
  POSTBACK_JOB_NAME: "process-postback",
}));
vi.mock("bullmq", () => ({
  Worker: function MockWorker(_name: string, processor: unknown) {
    (globalThis as Record<string, unknown>).__machinePathProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  },
}));

import { POST as dashboardCreate } from "../app/api/automations/route";
import { POST as machineUpsert } from "../app/api/automations/machine/upsert/route";
import { createDMWorker } from "../lib/queue/dm-worker";

const KEY = "m".repeat(48);
const BASE = "https://openreply.example.com";
const POST_ID = "17900000000000042";
const LINK = "https://www.vividsites.app/guides/ai-job-crew";
const DM = "here's the guide {username} 👇 {link}";

const account = {
  id: "acct_keith",
  workspaceId: "ws_1",
  instagramId: "ig_keith",
  username: "keithai_",
  accessToken: "encrypted",
  tokenExpiresAt: null,
};

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof machineUpsert>[0];
}

/** What Prisma would hand back to the worker for a row a route just created. */
function storedRow(createArgs: { data: Record<string, unknown> }, id: string) {
  const { trackedLinks, ...data } = createArgs.data as {
    trackedLinks?: { create: { slug: string; label: string; destinationUrl: string }[] };
  };
  return {
    // Same id for both, so the postback payload (`followcheck:<id>`) compares
    // equal; everything else must come from what the route stored.
    // Prisma column defaults the routes may leave unset.
    openingDmEnabled: false,
    openingDmMessage: null,
    openingDmButtonLabel: null,
    followUpEnabled: false,
    followUpMessage: null,
    ...data,
    id,
    instagramAccount: account,
    workspace: { id: "ws_1" },
    trackedLinks: (trackedLinks?.create ?? []).map((l) => ({
      slug: l.slug,
      label: l.label,
      destinationUrl: l.destinationUrl,
    })),
  };
}

async function createBothWays(opts: { requireFollow: boolean }) {
  mockPrisma.automation.create.mockClear();

  const dash = await dashboardCreate(
    jsonRequest(`${BASE}/api/automations`, {
      name: "AI job crew",
      instagramAccountId: account.id,
      postId: POST_ID,
      keywords: ["guide"],
      dmMessage: DM,
      trackedDestinationUrl: LINK,
      linkButtonLabel: "Get the guide",
      requireFollow: opts.requireFollow,
      followPromptMessage: "",
      followPromptButtonLabel: "",
      publicReplyEnabled: true,
      publicReplyMessages: ["sent 📩", " "],
    })
  );
  expect(dash.status).toBe(201);

  const machine = await machineUpsert(
    jsonRequest(
      `${BASE}/api/automations/machine/upsert`,
      {
        instagramUsername: "@keithai_",
        key: "ai-job-crew",
        postId: POST_ID,
        keywords: ["guide"],
        dmMessage: DM,
        linkUrl: LINK,
        requireFollow: opts.requireFollow,
        publicReplyMessages: ["sent 📩", " "],
      },
      { authorization: `Bearer ${KEY}` }
    )
  );
  expect(machine.status).toBe(201);

  const [dashArgs, machineArgs] = mockPrisma.automation.create.mock.calls.map(
    (c) => c[0]
  );
  return {
    dashArgs,
    machineArgs,
    dashRow: storedRow(dashArgs, "auto_1"),
    machineRow: storedRow(machineArgs, "auto_1"),
  };
}

type Processor = (job: {
  data: Record<string, unknown>;
  id: string;
  attemptsMade: number;
}) => Promise<void>;

async function runWorker(row: ReturnType<typeof storedRow>) {
  mockSendPrivateReply.mockClear();
  mockSendPrivateReplyWithLinkButton.mockClear();
  mockSendPrivateReplyWithButton.mockClear();
  mockPrisma.automation.findMany.mockResolvedValueOnce([row]);
  createDMWorker();
  const processor = (globalThis as Record<string, unknown>)
    .__machinePathProcessor as Processor;
  await processor({
    id: "job_1",
    attemptsMade: 0,
    data: {
      instagramAccountId: account.instagramId,
      commentId: "comment_1",
      commentText: "Guide please 🙏",
      commenterId: "commenter_1",
      commenterName: "sam",
      mediaId: POST_ID,
    },
  });
  return {
    linkButton: mockSendPrivateReplyWithLinkButton.mock.calls,
    plainText: mockSendPrivateReply.mock.calls,
    button: mockSendPrivateReplyWithButton.mock.calls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("AUTOMATION_API_KEY", KEY);
  vi.stubEnv("NEXTAUTH_URL", BASE);
  vi.stubEnv("DISABLE_LINK_TRACKING", "");
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws_1" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue(account);
  mockPrisma.instagramAccount.findMany.mockResolvedValue([account]);
  mockPrisma.automation.findUnique.mockResolvedValue(null);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
    id: "created",
    ...data,
    trackedLinks: (data.trackedLinks?.create ?? []).map(
      (l: { slug: string }) => ({ ...l })
    ),
  }));
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockResolvedValue({});
  mockGetUserFollowStatus.mockResolvedValue(true);
});

describe("machine-created campaigns take the dashboard's worker path", () => {
  it("stores the same behaviour columns as the dashboard builder", async () => {
    const { dashArgs, machineArgs } = await createBothWays({ requireFollow: true });
    const behaviour = [
      "workspaceId",
      "instagramAccountId",
      "postId",
      "pendingNextReel",
      "matchAnyPost",
      "keywords",
      "matchAnyWord",
      "wholeWordMatch",
      "dmMessage",
      "linkButtonLabel",
      "requireFollow",
      "followPromptMessage",
      "followPromptButtonLabel",
      "publicReplyEnabled",
      "publicReplyMessages",
      "publicReplyMessage",
      "isActive",
    ];
    for (const field of behaviour) {
      expect({ field, value: machineArgs.data[field] }).toEqual({
        field,
        value: dashArgs.data[field],
      });
    }
    expect(machineArgs.data.trackedLinks).toEqual(dashArgs.data.trackedLinks);
  });

  it("sends the link as a web_url button, never as a raw URL in text", async () => {
    const { dashRow, machineRow } = await createBothWays({ requireFollow: false });

    const fromDashboard = await runWorker(dashRow);
    const fromMachine = await runWorker(machineRow);

    expect(fromMachine).toEqual(fromDashboard);
    expect(fromMachine.plainText).toEqual([]);
    expect(fromMachine.linkButton).toEqual([
      [
        "plain_token",
        "ig_keith",
        "comment_1",
        "here's the guide sam 👇", // {link} stripped from the body
        [{ title: "Get the guide", url: `${BASE}/r/slug_fixed` }],
      ],
    ]);
  });

  it("still uses the button (with the destination inside) when link tracking is disabled", async () => {
    vi.stubEnv("DISABLE_LINK_TRACKING", "1");
    const { machineRow } = await createBothWays({ requireFollow: false });
    const sent = await runWorker(machineRow);
    expect(sent.plainText).toEqual([]);
    expect(sent.linkButton[0][4]).toEqual([{ title: "Get the guide", url: LINK }]);
  });

  it("follow gate: non-followers get the same default prompt either way", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false);
    const { dashRow, machineRow } = await createBothWays({ requireFollow: true });

    const fromDashboard = await runWorker(dashRow);
    const fromMachine = await runWorker(machineRow);

    expect(fromMachine).toEqual(fromDashboard);
    expect(fromMachine.linkButton).toEqual([]);
    expect(fromMachine.button[0][3]).toMatch(/^quick favor before i send your link/);
    expect(fromMachine.button[0][4]).toBe("i'm following");
    expect(fromMachine.button[0][5]).toBe("followcheck:auto_1");
  });
});
