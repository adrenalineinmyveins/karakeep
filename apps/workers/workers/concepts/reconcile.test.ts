import { beforeEach, describe, expect, test, vi } from "vitest";

// reconcile.ts 及其依赖 compiler.ts 均引用全局 db；替换为内存库跑真实 SQL
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
vi.mock("../mirrorExport", () => ({
  htmlToMarkdown: (html: string) => html,
}));

import { eq } from "drizzle-orm";

import { db } from "@saiye/db";
import {
  bookmarkLinks,
  bookmarkLists,
  bookmarkTags,
  bookmarks,
  bookmarksInLists,
  conceptPageSources,
  conceptPages,
  tagsOnBookmarks,
  users,
} from "@saiye/db/schema";
import {
  triggerConceptCompilation,
  triggerConceptMirrorDelete,
} from "@saiye/shared-server";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";

import { collectSourceSet, computeSourceHash } from "./compiler";
import { reconcileConceptPages } from "./reconcile";

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
  opts: { title?: string | null; modifiedAt?: Date } = {},
) {
  const id = nextId("bm");
  await db.insert(bookmarks).values({
    id,
    userId,
    type: BookmarkTypes.LINK,
    title: opts.title ?? null,
    source: "api",
    modifiedAt: opts.modifiedAt,
  });
  await db.insert(bookmarkLinks).values({ id, url: "https://example.com" });
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

beforeEach(async () => {
  await db.delete(conceptPageSources);
  await db.delete(conceptPages);
  await db.delete(tagsOnBookmarks);
  await db.delete(bookmarksInLists);
  await db.delete(bookmarkTags);
  await db.delete(bookmarkLists);
  await db.delete(bookmarkLinks);
  await db.delete(bookmarks);
  await db.delete(users);
  vi.mocked(triggerConceptCompilation).mockClear();
  vi.mocked(triggerConceptMirrorDelete).mockClear();
});

describe("reconcileConceptPages", () => {
  test("孤儿锚点：删除概念页并触发镜像删除", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const orphanId = await seedConceptPage(userId, "tag", "ghost-tag", {
      status: "ready",
      slug: "orphan-slug",
    });
    // 健康页：快照与当前来源一致，对账时不应被动到
    const bm = await seedLinkBookmark(userId);
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId: bm, tagId, attachedBy: "human" });
    const sources = await collectSourceSet(userId, "tag", tagId);
    const healthyId = await seedConceptPage(userId, "tag", tagId, {
      status: "ready",
      sourceCount: sources.length,
      sourceContentHash: computeSourceHash(sources),
    });

    const result = await reconcileConceptPages();

    expect(result).toEqual({ requeued: 0, deleted: 1 });
    const orphan = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, orphanId),
    });
    expect(orphan).toBeUndefined();
    const healthy = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, healthyId),
    });
    expect(healthy?.status).toEqual("ready");
    expect(triggerConceptMirrorDelete).toHaveBeenCalledWith(
      userId,
      "orphan-slug",
    );
  });

  test("卡死的 generating：重置 pending 并重新入队", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const pageId = await seedConceptPage(userId, "tag", tagId, {
      status: "generating",
      lastSourceChangeAt: new Date(Date.now() - 11 * 60 * 1000),
    });

    const result = await reconcileConceptPages();

    expect(result).toEqual({ requeued: 1, deleted: 0 });
    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("pending");
    expect(triggerConceptCompilation).toHaveBeenCalledWith(pageId);
  });

  test("新鲜的 generating：跳过不动", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const pageId = await seedConceptPage(userId, "tag", tagId, {
      status: "generating",
      lastSourceChangeAt: new Date(Date.now() - 60 * 1000),
    });

    const result = await reconcileConceptPages();

    expect(result).toEqual({ requeued: 0, deleted: 0 });
    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("generating");
    expect(triggerConceptCompilation).not.toHaveBeenCalled();
  });

  test("list 锚点 ready 且来源未变：跳过", async () => {
    const userId = await seedUser();
    const listId = await seedList(userId);
    const bm = await seedLinkBookmark(userId, {
      modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.insert(bookmarksInLists).values({ bookmarkId: bm, listId });
    const sources = await collectSourceSet(userId, "list", listId);
    await seedConceptPage(userId, "list", listId, {
      status: "ready",
      sourceCount: sources.length,
      sourceContentHash: computeSourceHash(sources),
    });

    const result = await reconcileConceptPages();

    expect(result).toEqual({ requeued: 0, deleted: 0 });
    expect(triggerConceptCompilation).not.toHaveBeenCalled();
  });

  test("来源数量变化：ready → stale 并入队", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const bm = await seedLinkBookmark(userId, { title: "唯一材料" });
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId: bm, tagId, attachedBy: "human" });
    // 页面快照记录的是 2 条来源，现在只剩 1 条
    const pageId = await seedConceptPage(userId, "tag", tagId, {
      status: "ready",
      sourceCount: 2,
      sourceContentHash: "outdated-hash",
    });

    const result = await reconcileConceptPages();

    expect(result).toEqual({ requeued: 1, deleted: 0 });
    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("stale");
    expect(triggerConceptCompilation).toHaveBeenCalledWith(pageId);
  });

  test("来源 modifiedAt 变化（数量一致）：同样检出 stale 并入队", async () => {
    const userId = await seedUser();
    const tagId = await seedTag(userId);
    const bm = await seedLinkBookmark(userId, {
      modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db
      .insert(tagsOnBookmarks)
      .values({ bookmarkId: bm, tagId, attachedBy: "human" });
    const sources = await collectSourceSet(userId, "tag", tagId);
    // 快照建立后书签被编辑
    await db
      .update(bookmarks)
      .set({ modifiedAt: new Date("2026-02-01T00:00:00.000Z") })
      .where(eq(bookmarks.id, bm));
    const pageId = await seedConceptPage(userId, "tag", tagId, {
      status: "ready",
      sourceCount: sources.length,
      sourceContentHash: computeSourceHash(sources),
    });

    const result = await reconcileConceptPages();

    expect(result.requeued).toEqual(1);
    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, pageId),
    });
    expect(page?.status).toEqual("stale");
    expect(triggerConceptCompilation).toHaveBeenCalledWith(pageId);
  });
});
