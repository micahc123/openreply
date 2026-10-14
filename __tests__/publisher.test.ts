import { beforeEach, describe, expect, it, vi } from "vitest";

type Post = {
  id: string;
  instagramAccountId: string;
  externalKey: string;
  caption: string;
  scheduledAt: Date;
  status: string;
  containerId: string | null;
  containerAt: Date | null;
  mediaId: string | null;
  permalink: string | null;
  error: string | null;
  attempts: number;
  publishedAt: Date | null;
  instagramAccount: { id: string; instagramId: string; accessToken: string };
  media: { kind: string; token: string }[];
};

const { mockPrisma, db } = vi.hoisted(() => {
  const db = { posts: [] as Post[], automations: [] as Record<string, unknown>[] };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    db,
    mockPrisma: {
      scheduledPost: {
        findMany: vi.fn(async ({ where }: { where: { OR: Record<string, unknown>[] } }) => {
          const now = (where.OR[0].scheduledAt as { lte: Date }).lte;
          return db.posts.filter(
            (p) =>
              (p.status === "SCHEDULED" && p.scheduledAt <= now) || p.status === "PROCESSING"
          );
        }),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (const p of db.posts) {
              if (!matches(p, where)) continue;
              Object.assign(p, data, {
                attempts:
                  typeof data.attempts === "object" ? p.attempts + 1 : (data.attempts ?? p.attempts),
              });
              count += 1;
            }
            return { count };
          }
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const p = db.posts.find((x) => x.id === where.id)!;
          Object.assign(p, data);
          return p;
        }),
      },
      postMedia: {
        deleteMany: vi.fn(async ({ where }: { where: { postId: string } }) => {
          const p = db.posts.find((x) => x.id === where.postId)!;
          const count = p.media.length;
          p.media = [];
          return { count };
        }),
      },
      automation: {
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            let count = 0;
            for (const a of db.automations) {
              if (!matches(a, where)) continue;
              Object.assign(a, data);
              count += 1;
            }
            return { count };
          }
        ),
      },
    },
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (t: string) => `plain-${t}` }));

import { mediaFileUrl, publishDuePosts } from "../lib/publishing/publisher";
import { parseRange } from "../lib/publishing/range";

const NOW = new Date("2026-10-15T16:00:00.000Z");

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: "post_1",
    instagramAccountId: "acct_henry",
    externalKey: "ai-job-crew",
    caption: "Comment crew and I'll send you the guide",
    scheduledAt: new Date("2026-10-15T15:59:00.000Z"),
    status: "SCHEDULED",
    containerId: null,
    containerAt: null,
    mediaId: null,
    permalink: null,
    error: null,
    attempts: 0,
    publishedAt: null,
    instagramAccount: { id: "acct_henry", instagramId: "1789", accessToken: "enc" },
    media: [
      { kind: "video", token: "vtok" },
      { kind: "cover", token: "ctok" },
    ],
    ...overrides,
  };
}

type Call = { url: string; method: string; body: string };
let calls: Call[];
let replies: Array<(call: Call) => { status?: number; json: unknown }>;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXTAUTH_URL", "https://openreply.example.com");
  db.posts = [];
  db.automations = [];
  calls = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") };
      calls.push(call);
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
      const { status = 200, json } = reply(call);
      return { ok: status < 400, status, json: async () => json } as Response;
    })
  );
});

describe("publishDuePosts", () => {
  it("leaves a post alone until its time", async () => {
    db.posts = [post({ scheduledAt: new Date("2026-10-15T17:00:00.000Z") })];
    const result = await publishDuePosts(NOW);
    expect(result).toEqual({ started: 0, published: 0, failed: 0, waiting: 0 });
    expect(calls).toHaveLength(0);
  });

  it("creates a REELS container from the public video and cover URLs", async () => {
    db.posts = [post()];
    replies.push(() => ({ json: { id: "container_9" } }));

    const result = await publishDuePosts(NOW);

    expect(result.started).toBe(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toMatch(/graph\.instagram\.com\/v[\d.]+\/1789\/media$/);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("media_type")).toBe("REELS");
    expect(body.get("video_url")).toBe("https://openreply.example.com/api/media/vtok/reel.mp4");
    expect(body.get("cover_url")).toBe("https://openreply.example.com/api/media/ctok/cover.jpg");
    expect(body.get("share_to_feed")).toBe("true");
    expect(body.get("caption")).toBe("Comment crew and I'll send you the guide");
    expect(db.posts[0]).toMatchObject({ status: "PROCESSING", containerId: "container_9", attempts: 1 });
  });

  it("waits while Instagram is still processing", async () => {
    db.posts = [post({ status: "PROCESSING", containerId: "c", containerAt: new Date(NOW.getTime() - 60_000) })];
    replies.push(() => ({ json: { status_code: "IN_PROGRESS" } }));

    const result = await publishDuePosts(NOW);

    expect(result.waiting).toBe(1);
    expect(db.posts[0].status).toBe("PROCESSING");
  });

  it("publishes a finished container, drops the files and binds the reel's campaign", async () => {
    db.posts = [post({ status: "PROCESSING", containerId: "c", containerAt: new Date(NOW.getTime() - 60_000) })];
    db.automations = [
      { id: "auto_1", instagramAccountId: "acct_henry", externalKey: "ai-job-crew", pendingNextReel: true, postId: null },
      { id: "auto_2", instagramAccountId: "acct_henry", externalKey: "other-reel", pendingNextReel: true, postId: null },
    ];
    replies.push(() => ({ json: { status_code: "FINISHED" } }));
    replies.push(() => ({ json: { id: "media_42" } }));
    replies.push(() => ({ json: { permalink: "https://www.instagram.com/reel/abc/" } }));

    const result = await publishDuePosts(NOW);

    expect(result.published).toBe(1);
    expect(calls[1].url).toMatch(/\/1789\/media_publish$/);
    expect(new URLSearchParams(calls[1].body).get("creation_id")).toBe("c");
    expect(db.posts[0]).toMatchObject({
      status: "PUBLISHED",
      mediaId: "media_42",
      permalink: "https://www.instagram.com/reel/abc/",
      media: [],
    });
    expect(db.automations[0]).toMatchObject({ postId: "media_42", pendingNextReel: false });
    expect(db.automations[1]).toMatchObject({ postId: null, pendingNextReel: true });
  });

  it("fails a post Instagram could not process", async () => {
    db.posts = [post({ status: "PROCESSING", containerId: "c", containerAt: new Date(NOW.getTime() - 60_000) })];
    replies.push(() => ({ json: { status_code: "ERROR", status: "Error: video too short" } }));

    const result = await publishDuePosts(NOW);

    expect(result.failed).toBe(1);
    expect(db.posts[0].status).toBe("FAILED");
    expect(db.posts[0].error).toContain("video too short");
  });

  it("says to reconnect when the token lacks the publish permission", async () => {
    db.posts = [post()];
    replies.push(() => ({
      status: 400,
      json: { error: { message: "Insufficient permission", code: 10, type: "OAuthException" } },
    }));

    const result = await publishDuePosts(NOW);

    expect(result.failed).toBe(1);
    expect(db.posts[0].status).toBe("FAILED");
    expect(db.posts[0].error).toContain("instagram_business_content_publish");
  });

  it("puts a post back in the queue after a network blip, then gives up", async () => {
    db.posts = [post()];
    const blip = () => {
      throw new Error("socket hang up");
    };
    replies.push(blip, blip, blip);

    await publishDuePosts(NOW);
    expect(db.posts[0]).toMatchObject({ status: "SCHEDULED", attempts: 1 });
    await publishDuePosts(NOW);
    expect(db.posts[0]).toMatchObject({ status: "SCHEDULED", attempts: 2 });
    await publishDuePosts(NOW);
    expect(db.posts[0]).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  it("never calls media_publish twice for one claim", async () => {
    db.posts = [post({ status: "PROCESSING", containerId: "c", containerAt: new Date(NOW.getTime() - 60_000) })];
    replies.push(() => ({ json: { status_code: "FINISHED" } }));
    replies.push(() => ({ status: 500, json: { error: { message: "boom", code: 2, type: "OAuthException" } } }));

    const result = await publishDuePosts(NOW);

    expect(result.failed).toBe(1);
    expect(db.posts[0].status).toBe("FAILED");
    expect(db.posts[0].error).toContain("it may have posted");
    expect(await publishDuePosts(NOW)).toEqual({ started: 0, published: 0, failed: 0, waiting: 0 });
  });

  it("re-queues a claim that died before Instagram answered", async () => {
    db.posts = [post({ status: "PROCESSING", containerId: null, containerAt: new Date(NOW.getTime() - 10 * 60_000) })];
    await publishDuePosts(NOW);
    expect(db.posts[0].status).toBe("SCHEDULED");
    expect(calls).toHaveLength(0);
  });
});

describe("mediaFileUrl", () => {
  it("ends in a file name Instagram recognises", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://x.example");
    expect(mediaFileUrl("t", "video")).toBe("https://x.example/api/media/t/reel.mp4");
    expect(mediaFileUrl("t", "cover")).toBe("https://x.example/api/media/t/cover.jpg");
  });
});

describe("parseRange", () => {
  it("reads open, closed and suffix ranges", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  it("rejects ranges it can't satisfy", () => {
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=20-10", 100)).toBe("invalid");
    expect(parseRange("bytes=-", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });
});
