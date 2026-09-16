import { beforeEach, describe, expect, test, vi } from "vitest";

// compiler.ts 引用全局 db（文件库）；流程测试在模块加载时替换为内存库跑真实 SQL
vi.mock("@saiye/db", async () => {
  const { getInMemoryDB } = await import("@saiye/db/drizzle");
  return { db: getInMemoryDB(true) };
});
vi.mock("@saiye/shared-server", () => ({
  triggerConceptMirrorExport: vi.fn(),
  triggerConceptMirrorDelete: vi.fn(),
  triggerConceptCompilation: vi.fn(),
}));
vi.mock("@saiye/shared/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// htmlToMarkdown mock 为恒等函数，便于断言内容提取逻辑本身
vi.mock("../mirrorExport", () => ({
  htmlToMarkdown: (html: string) => html,
}));

import { eq } from "drizzle-orm";

import { db } from "@saiye/db";
import {
  bookmarkLinks,
  bookmarkLists,
  bookmarkTags,
  bookmarkTexts,
  bookmarks,
  bookmarksInLists,
  conceptPageSources,
  conceptPages,
  tagsOnBookmarks,
  users,
} from "@saiye/db/schema";
import { triggerConceptMirrorExport } from "@saiye/shared-server";
import type { InferenceClient } from "@saiye/shared/inference";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";

import {
  collectSourceSet,
  compileConceptPage,
  computeSourceHash,
  markConceptFailure,
} from "./compiler";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

async function seedUser() {
  const id = nextId("user");
  await db.insert(users).values({ id, name: id, email: `${id}@test.local` });
  return id;
}

async function seedTag(userId: string, name = "标签") {
  const [row] = await db
    .insert(bookmarkTags)
    .values({ userId, name })
    .returning({ id: bookmarkTags.id });
  return row.id;
}

async function seedList(userId: string, name = "清单") {
  const [row] = await db
    .insert(bookmarkLists)
    .values({ userId, name, icon: "📚", type: "manual" })
    .returning({ id: bookmarkLists.id });
  return row.id;
}

async function seedLinkBookmark(
  userId: string,
  opts: {
    title?: string | null;
    url?: string;
    htmlContent?: string | null;
    modifiedAt?: Date;
    archived?: boolean;
  } = {},
) {
  const id = nextId("bm");
  await db.insert(bookmarks).values({
    id,
    userId,
    type: BookmarkTypes.LINK,
    title: opts.title ?? null,
    source: "api",
    modifiedAt: opts.modifiedAt,
    archived: opts.archived ?? false,
  });
  await db.insert(bookmarkLinks).values({
    id,
    url: opts.url ?? "https://example.com",
    htmlContent: opts.htmlContent ?? null,
  });
  return id;
}

async function seedTextBookmark(
  userId: string,
  opts: {
    title?: string | null;
    text?: string | null;
    sourceUrl?: string | null;
    modifiedAt?: Date;
  } = {},
) {
  const id = nextId("bm");
  await db.insert(bookmarks).values({
    id,
    userId,
    type: BookmarkTypes.TEXT,
    title: opts.title ?? null,
    source: "api",
    modifiedAt: opts.modifiedAt,
  });
  await db.insert(bookmarkTexts).values({
    id,
    text: opts.text ?? null,
    sourceUrl: opts.sourceUrl ?? null,
  });
  return id;
}

async function seedConceptPage(
  userId: string,
  anchorType: "tag" | "list",
  anchorId: string,
  overrides: Partial<typeof conceptPages.$inferInsert> = {},
) {
  const id = nextId("cp");
  await db.insert(conceptPages).values({
    id,
    userId,
    anchorType,
    anchorId,
    title: "占位标题",
    slug: `slug-${id}`,
    ...overrides,
  });
  return id;
}

function makeInferenceClient(response: string, totalTokens = 42) {
  const inferFromText = vi.fn().mockResolvedValue({ response, totalTokens });
  return {
    inferFromText,
    client: { inferFromText } as unknown as InferenceClient,
  };
}

beforeEach(async () => {
  await db.delete(conceptPageSources);
  await db.delete(conceptPages);
  await db.delete(tagsOnBookmarks);
  await db.delete(bookmarksInLists);
  await db.delete(bookmarkTags);
  await db.delete(bookmarkLists);
  await db.delete(bookmarkTexts);
  await db.delete(bookmarkLinks);
  await db.delete(bookmarks);
  await db.delete(users);
  vi.mocked(triggerConceptMirrorExport).mockClear();
});

describe("collectSourceSet", () => {
  test("tag 锚点：收集挂载的未归档书签，排除 archived", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const kept = await seedLinkBookmark(userId, { title: "保留" });
    const archived = await seedLinkBookmark(userId, { archived: true });
    await db.insert(tagsOnBookmarks).values([
      { bookmarkId: kept, tagId, attachedBy: "human" },
      { bookmarkId: archived, tagId, attachedBy: "human" },
    ]);

    const sources = await collectSourceSet(userId, "tag", tagId);
    expect(sources.map((s) => s.bookmarkId)).toEqual([kept]);
    expect(sources[0].title).toEqual("保留");
  });

  test("list 锚点：收集清单内书签", async () => {
    const userId = await seedUser();
    const listId = await seedList(userId);
    const bm = await seedTextBookmark(userId, { title: "笔记" });
    await db.insert(bookmarksInLists).values({ bookmarkId: bm, listId });

    const sources = await collectSourceSet(userId, "list", listId);
    expect(sources.map((s) => s.bookmarkId)).toEqual([bm]);
  });

  test("link 书签：content 来自 htmlContent 转 Markdown，url 取 link.url", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const bm = await seedLinkBookmark(userId, {
      url: "https://example.com/a",
      htmlContent: "<p>正文</p>",
    });
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId: bm, tagId, attachedBy: "human" });

    const [source] = await collectSourceSet(userId, "tag", tagId);
    expect(source.url).toEqual("https://example.com/a");
    expect(source.content).toEqual("<p>正文</p>");
  });

  test("text 书签：content 取正文，url 回退 sourceUrl", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const bm = await seedTextBookmark(userId, {
      text: "纯文本笔记",
      sourceUrl: "https://t.example/x",
    });
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId: bm, tagId, attachedBy: "human" });

    const [source] = await collectSourceSet(userId, "tag", tagId);
    expect(source.url).toEqual("https://t.example/x");
    expect(source.content).toEqual("纯文本笔记");
  });

  test("无 htmlContent 的 link 书签 content 为 null", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const bm = await seedLinkBookmark(userId, { url: "https://example.com" });
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId: bm, tagId, attachedBy: "human" });

    const [source] = await collectSourceSet(userId, "tag", tagId);
    expect(source.content).toBeNull();
    expect(source.url).toEqual("https://example.com");
  });

  test("超过 30 条时按 modifiedAt 倒序保留最新 30 条", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const ids: string[] = [];
    for (let i = 0; i < 32; i++) {
      const id = await seedLinkBookmark(userId, {
        title: `bm-${i}`,
        modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
      ids.push(id);
      await db
        .insert(tagsOnBookmarks)
        .values({ bookmarkId: id, tagId, attachedBy: "human" });
    }

    const sources = await collectSourceSet(userId, "tag", tagId);
    expect(sources).toHaveLength(30);
    expect(sources[0].bookmarkId).toEqual(ids[31]);
    expect(sources.map((s) => s.bookmarkId)).not.toContain(ids[0]);
    expect(sources.map((s) => s.bookmarkId)).not.toContain(ids[1]);
  });
});

describe("compileConceptPage", () => {
  test("概念页不存在时返回 missing", async () => {
    const { client } = makeInferenceClient("## 综述");
    await expect(compileConceptPage("no-such-page", client)).resolves.toEqual(
      "missing",
    );
  });

  test("锚点被删除：标记 anchor_deleted 并返回 skipped", async () => {
    const userId = await seedUser();
    const pageId = await seedConceptPage(userId, "tag", "ghost-tag", {
      content: "旧内容",
    });
    const { client, inferFromText } = makeInferenceClient("## 新综述");

    const result = await compileConceptPage(pageId, client);

    expect(result).toEqual("skipped");
    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("failure");
    expect(page?.lastError).toEqual("anchor_deleted");
    expect(page?.content).toEqual("旧内容");
    expect(inferFromText).not.toHaveBeenCalled();
    expect(triggerConceptMirrorExport).not.toHaveBeenCalled();
  });

  test("无来源：不调用 LLM，直接写入空内容并置 ready", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId, "空标签");
    const pageId = await seedConceptPage(userId, "tag", tagId);
    const { client, inferFromText } = makeInferenceClient("不应被调用");

    const result = await compileConceptPage(pageId, client);

    expect(result).toEqual("compiled");
    expect(inferFromText).not.toHaveBeenCalled();
    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("ready");
    expect(page?.content).toEqual("");
    expect(page?.sourceCount).toEqual(0);
    // 标题同步为锚点当前名称
    expect(page?.title).toEqual("空标签");
    expect(triggerConceptMirrorExport).toHaveBeenCalledWith(pageId);
  });

  test("正常编译：写回内容、来源快照、hash 与版本号", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId, "rust");
    const linkBm = await seedLinkBookmark(userId, {
      title: "Rust Book",
      url: "https://doc.rust-lang.org",
      htmlContent: "<p>ownership</p>",
    });
    const textBm = await seedTextBookmark(userId, {
      text: "借用检查笔记",
      sourceUrl: "https://t.example/n",
    });
    await db.insert(tagsOnBookmarks).values([
      { bookmarkId: linkBm, tagId, attachedBy: "human" },
      { bookmarkId: textBm, tagId, attachedBy: "human" },
    ]);
    const pageId = await seedConceptPage(userId, "tag", tagId, {
      compileVersion: 1,
    });
    // 预置一条指向“已不在锚点上”书签的过期来源行，编译后应被重建
    const detachedBm = await seedLinkBookmark(userId, { title: "已移出" });
    await db
      .insert(conceptPageSources)
      .values({ pageId, bookmarkId: detachedBm });
    const { client, inferFromText } = makeInferenceClient(
      "## 核心概念\n所有权 [1]",
    );

    const result = await compileConceptPage(pageId, client);

    expect(result).toEqual("compiled");
    expect(inferFromText).toHaveBeenCalledTimes(1);
    const prompt = inferFromText.mock.calls[0][0] as string;
    expect(prompt).toContain("「rust」");
    expect(prompt).toContain("Rust Book");
    expect(prompt).toContain("借用检查笔记");

    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("ready");
    expect(page?.content).toEqual("## 核心概念\n所有权 [1]");
    expect(page?.sourceCount).toEqual(2);
    expect(page?.compileVersion).toEqual(2);
    expect(page?.lastCompiledAt).not.toBeNull();
    const expectedHash = computeSourceHash(
      await collectSourceSet(userId, "tag", tagId),
    );
    expect(page?.sourceContentHash).toEqual(expectedHash);

    const sourceRows = await db.select().from(conceptPageSources);
    expect(sourceRows.map((r) => r.bookmarkId).sort()).toEqual(
      [linkBm, textBm].sort(),
    );
    expect(triggerConceptMirrorExport).toHaveBeenCalledWith(pageId);
  });

  test("LLM 空响应：抛错并停留在 generating", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const bm = await seedLinkBookmark(userId, { title: "材料" });
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId: bm, tagId, attachedBy: "human" });
    const pageId = await seedConceptPage(userId, "tag", tagId);
    const { client } = makeInferenceClient("   ");

    await expect(compileConceptPage(pageId, client)).rejects.toThrowError(
      /Empty response/,
    );

    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("generating");
    expect(page?.compileVersion).toEqual(0);
    expect(triggerConceptMirrorExport).not.toHaveBeenCalled();
  });
});

describe("markConceptFailure", () => {
  test("仅标记 failure 与 lastError，保留旧内容", async () => {
    const userId = await seedUser();
    const pageId = await seedConceptPage(userId, "tag", "ghost", {
      status: "ready",
      content: "旧综述",
      compileVersion: 3,
    });

    await markConceptFailure(pageId, "boom");

    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("failure");
    expect(page?.lastError).toEqual("boom");
    expect(page?.content).toEqual("旧综述");
    expect(page?.compileVersion).toEqual(3);
  });
});
