import { beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  agentMemories,
  bookmarkLinks,
  bookmarkLists,
  bookmarkTags,
  bookmarks,
  bookmarksInLists,
  chatMessages,
  chatSessions,
  conceptPages,
  tagsOnBookmarks,
  users,
} from "@saiye/db/schema";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";
import { triggerConceptCompilation } from "@saiye/shared-server";

// P2 stale 重编译闭环：咨询读路径会 fire-and-forget 触发重编译入队，
// mock 掉避免单测环境初始化真实队列客户端，并验证触发行为。
vi.mock("@saiye/shared-server", () => ({
  triggerConceptCompilation: vi.fn().mockResolvedValue(undefined),
}));

// 注意：本文件不 mock @saiye/db（与 knowledgeRetrieval.test.ts 不同）——
// 咨询链路需要真实表结构，db 实例通过 params.db 注入 in-memory 测试库。
import type { KnowledgeChunk } from "./knowledgeRetrieval";
import { retrieveKnowledgeContext } from "./knowledgeRetrieval";

import type { CustomTestContext } from "../../testUtils";
import { defaultBeforeEach } from "../../testUtils";
import type { TestDB } from "../../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));
beforeEach(() => {
  vi.clearAllMocks();
});

const QUERY = "Rust 异步编程";

/** 以用户 0（领域专家所有者）的身份铺一组可检索知识 */
async function seedOwnerKnowledge(db: TestDB, ownerId: string) {
  // L1 概念页（咨询模式专属源）
  await db.insert(conceptPages).values({
    id: "concept-rust-1",
    userId: ownerId,
    anchorType: "tag",
    anchorId: "tag-rust",
    title: "Rust 所有权",
    slug: "rust-ownership",
    content: "所有权与借用是 Rust 内存安全的核心机制",
  });

  // L2 书签（link 型，title/url 是要脱敏的来源元数据）
  await db.insert(bookmarks).values({
    id: "bm-rust-1",
    userId: ownerId,
    type: BookmarkTypes.LINK,
    summary: "tokio 异步运行时与 async/await 编程模型详解",
    source: "api",
  });
  await db.insert(bookmarkLinks).values({
    id: "bm-rust-1",
    url: "https://rust.example/async",
    title: "Rust 异步编程指南",
  });

  // 私人维度：长期记忆 + 历史会话（咨询模式必须排除）
  await db.insert(agentMemories).values({
    userId: ownerId,
    content: "用户偏好简洁的中文回答",
  });
  await db.insert(chatSessions).values({
    id: "chat-owner-1",
    title: "Rust 学习",
    userId: ownerId,
  });
  await db.insert(chatMessages).values({
    chatId: "chat-owner-1",
    role: "user",
    content: "之前讨论过 Rust 异步编程的调度器",
  });
}

async function getOwnerId(context: CustomTestContext): Promise<string> {
  const [owner] = await context.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "test1@test.com"));
  return owner.id;
}

describe("retrieveKnowledgeContext — consultation (D3)", () => {
  test<CustomTestContext>("咨询模式：概念页带标题注入，书签片段脱敏（title/url 剥离），memory/chat 排除", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedOwnerKnowledge(context.db, ownerId);

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: QUERY,
      consultation: true,
      db: context.db,
    });

    // L1 概念页：保留标题，不脱敏
    const concept = chunks.find((c) => c.source === "concept");
    expect(concept).toBeDefined();
    expect(concept!.title).toBe("Rust 所有权");
    expect(concept!.content).toContain("所有权与借用");
    expect(concept!.sanitized).toBeUndefined();

    // L2 书签：内容在，来源元数据剥离
    const bm = chunks.find((c) => c.source === "bookmark" && !c.viaGraph) as
      | KnowledgeChunk
      | undefined;
    expect(bm).toBeDefined();
    expect(bm!.sanitized).toBe(true);
    expect(bm!.title).toBeUndefined();
    expect(bm!.url).toBeUndefined();
    expect(bm!.content).toContain("tokio");

    // 私人维度排除
    expect(chunks.find((c) => c.source === "memory")).toBeUndefined();
    expect(chunks.find((c) => c.source === "chat")).toBeUndefined();
  });

  test<CustomTestContext>("概念页 stale/failure 状态标记 stale（D5 降级信号），正常状态不标记", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedOwnerKnowledge(context.db, ownerId);
    // 追加一页编译失败的概念页（content 是旧编译产物，D3 保留旧值）
    await context.db.insert(conceptPages).values({
      id: "concept-rust-2",
      userId: ownerId,
      anchorType: "tag",
      anchorId: "tag-rust-2",
      title: "Rust 生命周期",
      slug: "rust-lifetime",
      content: "生命周期标注是 Rust 借用检查的一部分",
      status: "failure",
    });

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: QUERY,
      consultation: true,
      db: context.db,
    });

    const concepts = chunks.filter((c) => c.source === "concept");
    expect(
      concepts.some((c) => c.title === "Rust 生命周期" && c.stale === true),
    ).toBe(true);
    expect(
      concepts.find((c) => c.title === "Rust 所有权")!.stale,
    ).toBeUndefined();
  });

  test<CustomTestContext>("P2 stale 重编译闭环：命中 stale/failure 页时惰性触发重编译，正常页不触发", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedOwnerKnowledge(context.db, ownerId);
    // 追加一页过期概念页（content 是旧编译产物）
    await context.db.insert(conceptPages).values({
      id: "concept-rust-2",
      userId: ownerId,
      anchorType: "tag",
      anchorId: "tag-rust-2",
      title: "Rust 生命周期",
      slug: "rust-lifetime",
      content: "生命周期标注是 Rust 借用检查的一部分",
      status: "stale",
    });

    await retrieveKnowledgeContext({
      userId: ownerId,
      query: QUERY,
      consultation: true,
      db: context.db,
    });

    // 只有入选的 stale 页被触发；
    // concept-rust-1 是 pending 状态（已入队待编译），不重复触发
    expect(triggerConceptCompilation).toHaveBeenCalledTimes(1);
    expect(triggerConceptCompilation).toHaveBeenCalledWith("concept-rust-2");
  });

  test<CustomTestContext>("个人模式回归：书签带 title/url，memory/chat 正常注入", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedOwnerKnowledge(context.db, ownerId);

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: QUERY,
      db: context.db,
    });

    // 书签：来源元数据完整保留
    const bm = chunks.find((c) => c.source === "bookmark" && !c.viaGraph) as
      | KnowledgeChunk
      | undefined;
    expect(bm).toBeDefined();
    expect(bm!.sanitized).toBeUndefined();
    expect(bm!.title).toBe("Rust 异步编程指南");
    expect(bm!.url).toBe("https://rust.example/async");

    // 私人维度正常注入
    expect(chunks.find((c) => c.source === "memory")).toBeDefined();
    const chat = chunks.find((c) => c.source === "chat");
    expect(chat).toBeDefined();
    expect(chat!.content).toContain("调度器");
  });
});

// ── per-profile 语料隔离（scope） ─────────────────────

/** 查询词"编程"可同时命中 rust/python 两侧语料，便于断言隔离边界 */
const SCOPED_QUERY = "编程";

/**
 * 铺两组可对照的语料：rust 侧（tag-rust + list-rust）与 python 侧
 * （tag-python + list-python）。概念页锚点与书签挂载一一对应。
 */
async function seedScopedKnowledge(db: TestDB, ownerId: string) {
  await db.insert(bookmarkTags).values([
    { id: "tag-rust", userId: ownerId, name: "rust" },
    { id: "tag-python", userId: ownerId, name: "python" },
  ]);
  await db.insert(bookmarkLists).values([
    {
      id: "list-rust",
      userId: ownerId,
      name: "Rust 清单",
      icon: "📦",
      type: "manual",
    },
    {
      id: "list-python",
      userId: ownerId,
      name: "Python 清单",
      icon: "📦",
      type: "manual",
    },
  ]);
  await db.insert(conceptPages).values([
    {
      id: "concept-scoped-rust",
      userId: ownerId,
      anchorType: "tag",
      anchorId: "tag-rust",
      title: "Rust 所有权编程",
      slug: "rust-ownership-scoped",
      content: "所有权与借用是 Rust 编程核心",
    },
    {
      id: "concept-scoped-python",
      userId: ownerId,
      anchorType: "list",
      anchorId: "list-python",
      title: "Python GIL 编程",
      slug: "python-gil-scoped",
      content: "全局解释器锁是 Python 并发编程核心",
    },
  ]);
  await db.insert(bookmarks).values([
    {
      id: "bm-scoped-rust",
      userId: ownerId,
      type: BookmarkTypes.LINK,
      summary: "tokio 异步编程与 Rust",
      source: "api",
    },
    {
      id: "bm-scoped-python",
      userId: ownerId,
      type: BookmarkTypes.LINK,
      summary: "GIL 全局解释器锁与 Python 编程",
      source: "api",
    },
  ]);
  await db.insert(bookmarkLinks).values([
    {
      id: "bm-scoped-rust",
      url: "https://rust.example/scoped",
      title: "Rust scoped",
    },
    {
      id: "bm-scoped-python",
      url: "https://python.example/scoped",
      title: "Python scoped",
    },
  ]);
  await db.insert(tagsOnBookmarks).values([
    {
      bookmarkId: "bm-scoped-rust",
      tagId: "tag-rust",
      attachedBy: "human",
    },
    {
      bookmarkId: "bm-scoped-python",
      tagId: "tag-python",
      attachedBy: "human",
    },
  ]);
  await db.insert(bookmarksInLists).values([
    { bookmarkId: "bm-scoped-rust", listId: "list-rust" },
    { bookmarkId: "bm-scoped-python", listId: "list-python" },
  ]);
}

/** 任意片段内容是否提及 python 侧语料 */
function mentionsPython(chunks: KnowledgeChunk[]): boolean {
  return chunks.some(
    (c) => c.content.includes("GIL") || c.content.includes("Python"),
  );
}

describe("retrieveKnowledgeContext — knowledgeScope (per-profile 隔离)", () => {
  test<CustomTestContext>("scope 绑定标签：只命中该标签下的概念页与书签，另一侧全量存在但不注入", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedScopedKnowledge(context.db, ownerId);

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: SCOPED_QUERY,
      consultation: true,
      knowledgeScope: { tagIds: ["tag-rust"], listIds: [] },
      db: context.db,
    });

    // rust 侧命中：概念页（锚点 tag-rust）+ 书签（挂 tag-rust）
    const concept = chunks.find((c) => c.source === "concept");
    expect(concept).toBeDefined();
    expect(concept!.title).toBe("Rust 所有权编程");
    expect(chunks.some((c) => c.content.includes("tokio"))).toBe(true);

    // python 侧被隔离（概念页锚点 list-python 不匹配，书签不挂 tag-rust）
    expect(mentionsPython(chunks)).toBe(false);
  });

  test<CustomTestContext>("scope 绑定清单：listIds 命中挂载该书签的语料", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedScopedKnowledge(context.db, ownerId);

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: SCOPED_QUERY,
      consultation: true,
      knowledgeScope: { tagIds: [], listIds: ["list-python"] },
      db: context.db,
    });

    // python 侧命中：概念页（锚点 list-python）+ 书签（在 list-python）
    expect(chunks.some((c) => c.content.includes("GIL"))).toBe(true);
    // rust 侧被隔离
    expect(chunks.some((c) => c.content.includes("tokio"))).toBe(false);
    expect(chunks.some((c) => c.content.includes("所有权"))).toBe(false);
  });

  test<CustomTestContext>("scope 绑定不存在的标签：空语料，不注入任何片段", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedScopedKnowledge(context.db, ownerId);

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: SCOPED_QUERY,
      consultation: true,
      knowledgeScope: { tagIds: ["tag-nope"], listIds: [] },
      db: context.db,
    });

    expect(chunks).toHaveLength(0);
  });

  test<CustomTestContext>("scope 为空集合（两者皆空）：退化为全量语料（兼容现状）", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedScopedKnowledge(context.db, ownerId);

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: SCOPED_QUERY,
      consultation: true,
      knowledgeScope: { tagIds: [], listIds: [] },
      db: context.db,
    });

    // 两侧都注入
    expect(chunks.some((c) => c.content.includes("所有权"))).toBe(true);
    expect(chunks.some((c) => c.content.includes("GIL"))).toBe(true);
  });

  test<CustomTestContext>("无 scope（undefined）：全量语料，行为与旧链路一致", async (context) => {
    const ownerId = await getOwnerId(context);
    await seedScopedKnowledge(context.db, ownerId);

    const chunks = await retrieveKnowledgeContext({
      userId: ownerId,
      query: SCOPED_QUERY,
      consultation: true,
      db: context.db,
    });

    expect(chunks.some((c) => c.content.includes("所有权"))).toBe(true);
    expect(chunks.some((c) => c.content.includes("GIL"))).toBe(true);
  });
});
