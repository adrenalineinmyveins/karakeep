import { beforeEach, describe, expect, test, vi } from "vitest";

// 单测：真实 in-memory 库（跑真实 SQL + 迁移）+ 可控推理桩。
// 覆盖：首次喂养、增量游标（D2-b）、memories 去重、nurtureAuto 手工接管、
// cron 触发评估阈值。

vi.mock("@saiye/db", async () => {
  const { getInMemoryDB } = await import("@saiye/db/drizzle");
  return { db: await getInMemoryDB(true) };
});
vi.mock("@saiye/shared/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  throttledLogger: () => vi.fn(),
}));

import { eq } from "drizzle-orm";

import { db } from "@saiye/db";
import {
  agentMemories,
  agentProfiles,
  bookmarkLinks,
  bookmarks,
  users,
} from "@saiye/db/schema";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";

import type { InferenceClient } from "@saiye/shared/inference";

import { NURTURE_MIN_CHANGES, shouldNurture, nurtureProfile } from "./nurture";

let seq = 0;

async function seedUser() {
  const id = `user-${++seq}`;
  await db.insert(users).values({ id, name: id, email: `${id}@test.local` });
  return id;
}

async function seedProfile(
  userId: string,
  overrides: Partial<typeof agentProfiles.$inferInsert> = {},
) {
  const id = `profile-${++seq}`;
  await db.insert(agentProfiles).values({
    id,
    userId,
    name: "知识管家",
    type: "hosted",
    ...overrides,
  });
  return id;
}

/** 书签 modifiedAt 受控（增量游标测试的关键） */
async function seedBookmark(
  userId: string,
  opts: { title: string; summary: string; modifiedAt: Date },
) {
  const id = `bm-${++seq}`;
  await db.insert(bookmarks).values({
    id,
    userId,
    type: BookmarkTypes.LINK,
    summary: opts.summary,
    source: "api",
    modifiedAt: opts.modifiedAt,
  });
  await db.insert(bookmarkLinks).values({
    id,
    url: "https://example.com",
    title: opts.title,
  });
  return id;
}

/** 可控推理桩：返回固定结构化输出，记录 prompt 便于断言批次内容 */
function stubClient(output: {
  bio: string;
  expertiseTags: string[];
  memories: string[];
}) {
  const inferFromText = vi.fn().mockResolvedValue({
    response: JSON.stringify(output),
    totalTokens: 123,
  });
  const client = { inferFromText };
  return {
    client: client as unknown as InferenceClient,
    inferFromText,
  };
}

const T0 = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("nurtureProfile — D2-a 喂养主流程", () => {
  test("首次喂养：bio/专长标签/游标落库 + memories 沉淀", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId);
    await seedBookmark(userId, {
      title: "Rust 异步编程",
      summary: "tokio 运行时",
      modifiedAt: T0,
    });

    const { client } = stubClient({
      bio: "精通 Rust 的知识管家",
      expertiseTags: ["Rust", "异步编程", "系统编程"],
      memories: ["用户近期在系统性学习 Rust 异步生态"],
    });
    const result = await nurtureProfile(db as never, client, profileId);

    expect(result).toBe("done");
    const [profile] = await db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, profileId));
    expect(profile.bio).toBe("精通 Rust 的知识管家");
    expect(profile.expertiseTags).toEqual(["Rust", "异步编程", "系统编程"]);
    // 游标 = 本批最新 modifiedAt
    expect(profile.nurtureState?.lastCursor).toBe(T0.toISOString());
    expect(profile.nurtureState?.runsCount).toBe(1);

    const memories = await db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.userId, userId));
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toBe("用户近期在系统性学习 Rust 异步生态");
  });

  test("D2-b 增量游标：无新书签时不调 LLM（no_changes 心跳）", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId);
    await seedBookmark(userId, {
      title: "旧书签",
      summary: "s",
      modifiedAt: T0,
    });

    const { client, inferFromText: infer } = stubClient({
      bio: "b",
      expertiseTags: ["t1", "t2", "t3"],
      memories: [],
    });
    await nurtureProfile(db as never, client, profileId);
    expect(infer).toHaveBeenCalledTimes(1);

    // 第二次：无增量 → 不再调 LLM
    const second = await nurtureProfile(db as never, client, profileId);
    expect(second).toBe("no_changes");
    expect(infer).toHaveBeenCalledTimes(1);
  });

  test("增量批次只含游标之后的新书签（旧书签不重复喂）", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId);
    await seedBookmark(userId, {
      title: "旧书签",
      summary: "old",
      modifiedAt: T0,
    });

    const { client, inferFromText: infer } = stubClient({
      bio: "b",
      expertiseTags: ["t1", "t2", "t3"],
      memories: [],
    });
    await nurtureProfile(db as never, client, profileId);

    const t1 = new Date("2026-01-02T00:00:00.000Z");
    await seedBookmark(userId, {
      title: "新书签",
      summary: "new",
      modifiedAt: t1,
    });
    await nurtureProfile(db as never, client, profileId);

    expect(infer).toHaveBeenCalledTimes(2);
    const calls = (infer as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const secondPrompt = calls[1]![0] as string;
    expect(secondPrompt).toContain("新书签");
    expect(secondPrompt).not.toContain("旧书签");
  });

  test("memories 精确去重：重复沉淀同内容只保留一条", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId);
    await seedBookmark(userId, {
      title: "a",
      summary: "s",
      modifiedAt: T0,
    });

    const { client } = stubClient({
      bio: "b",
      expertiseTags: ["t1", "t2", "t3"],
      memories: ["重复记忆"],
    });
    await nurtureProfile(db as never, client, profileId);

    // 推进游标后再喂一次（同 memories 输出）
    await seedBookmark(userId, {
      title: "b",
      summary: "s",
      modifiedAt: new Date("2026-01-03T00:00:00.000Z"),
    });
    await nurtureProfile(db as never, client, profileId);

    const memories = await db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.userId, userId));
    expect(memories).toHaveLength(1);
  });

  test("nurtureAuto=false：bio/标签不被覆盖（手工接管），memories 仍沉淀", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId, {
      nurtureAuto: false,
      bio: "用户手写的简介",
      expertiseTags: ["手工标签"],
    });
    await seedBookmark(userId, {
      title: "x",
      summary: "s",
      modifiedAt: T0,
    });

    const { client } = stubClient({
      bio: "LLM 生成的简介",
      expertiseTags: ["a1", "a2", "a3"],
      memories: ["记忆照常沉淀"],
    });
    await nurtureProfile(db as never, client, profileId);

    const [profile] = await db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, profileId));
    expect(profile.bio).toBe("用户手写的简介");
    expect(profile.expertiseTags).toEqual(["手工标签"]);

    const memories = await db
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.userId, userId));
    expect(memories).toHaveLength(1);
  });

  test("非 hosted 档案跳过（外接大脑在外部喂养）", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId, {
      type: "openai-compatible",
      baseUrl: "https://api.example.com",
      model: "gpt-4o",
    });
    await seedBookmark(userId, {
      title: "x",
      summary: "s",
      modifiedAt: T0,
    });

    const { client, inferFromText: infer } = stubClient({
      bio: "b",
      expertiseTags: ["t1", "t2", "t3"],
      memories: [],
    });
    const result = await nurtureProfile(db as never, client, profileId);
    expect(result).toBe("skipped");
    expect(infer).not.toHaveBeenCalled();
  });
});

describe("shouldNurture — D2-b cron 触发评估", () => {
  test("非 hosted 或 nurtureAuto=false：不触发", async () => {
    const userId = await seedUser();
    const cliProfile = await seedProfile(userId, {
      type: "openai-compatible",
      baseUrl: "https://api.example.com",
      model: "m",
    });
    expect(
      await shouldNurture(db as never, {
        id: cliProfile,
        userId,
        type: "openai-compatible",
        nurtureAuto: true,
        knowledgeScope: null,
        nurtureState: null,
      }),
    ).toBe(false);

    const manualProfile = await seedProfile(userId, { nurtureAuto: false });
    expect(
      await shouldNurture(db as never, {
        id: manualProfile,
        userId,
        type: "hosted",
        nurtureAuto: false,
        knowledgeScope: null,
        nurtureState: null,
      }),
    ).toBe(false);
  });

  test("无增量：不触发；增量达阈值：触发", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId);
    const base = {
      id: profileId,
      userId,
      type: "hosted",
      nurtureAuto: true,
      knowledgeScope: null,
      // 游标卡在未来 → 一切书签都算增量
      nurtureState: {
        lastCursor: new Date("2027-01-01T00:00:00.000Z").toISOString(),
        lastRunAt: Date.now(),
        runsCount: 1,
      },
    } as const;

    // 游标在未来，无增量
    expect(await shouldNurture(db as never, base)).toBe(false);

    // 游标重置为过去，增量 = 全部书签
    const t = T0;
    for (let i = 0; i < NURTURE_MIN_CHANGES; i++) {
      await seedBookmark(userId, {
        title: `bm${i}`,
        summary: "s",
        modifiedAt: t,
      });
    }
    expect(
      await shouldNurture(db as never, {
        ...base,
        nurtureState: null,
      }),
    ).toBe(true);
  });

  test("少量增量 + 超过兜底周期：仍触发（低频用户定期刷新）", async () => {
    const userId = await seedUser();
    const profileId = await seedProfile(userId);
    await seedBookmark(userId, {
      title: "仅一条",
      summary: "s",
      modifiedAt: T0,
    });

    // 少量增量 + 刚跑过 → 不触发
    expect(
      await shouldNurture(db as never, {
        id: profileId,
        userId,
        type: "hosted",
        nurtureAuto: true,
        knowledgeScope: null,
        nurtureState: { lastCursor: null, lastRunAt: Date.now(), runsCount: 1 },
      }),
    ).toBe(false);

    // 少量增量 + 8 天前跑过 → 触发
    expect(
      await shouldNurture(db as never, {
        id: profileId,
        userId,
        type: "hosted",
        nurtureAuto: true,
        knowledgeScope: null,
        nurtureState: {
          lastCursor: null,
          lastRunAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          runsCount: 1,
        },
      }),
    ).toBe(true);
  });
});
