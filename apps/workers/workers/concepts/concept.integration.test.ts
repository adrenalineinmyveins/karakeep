import { promises as fsp } from "node:fs";
import assert from "node:assert";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// 集成测试：打通「triggerConceptCompilation → liteque 队列（临时目录）→
// ConceptWorker → 编译落库 → triggerConceptMirrorExport → MirrorExportWorker →
// 磁盘镜像」全链路。@saiye/shared-server（真实队列）与 ../mirrorExport 均为真实实现。
//
// 仅替换四类边界：
// 1. 全局文件库 → 内存库（跑真实 SQL + 迁移）
// 2. config → dataDir/mirrorExport 指向临时目录（queue.db 与镜像文件完全隔离）
// 3. 推理客户端 → 可控桩（成功脚本 / 失败脚本 / 未配置）
// 4. metrics / workerTracing 裸导入（仅 tsc baseUrl 可解析，vitest 下必须 mock）

const tmpDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  return `${base.endsWith("/") ? base : `${base}/`}concept-it-${process.pid}-${Date.now()}`;
});
const inferenceState = vi.hoisted(() => ({
  client: null as { inferFromText: ReturnType<typeof vi.fn> } | null,
}));

// 真实 drizzle.ts 在模块加载时会按 config 打开文件库（db.db）；
// 指向 :memory: 可避免 Windows 下残留句柄导致清理 EBUSY
vi.mock("@saiye/db/drizzle.config", () => ({
  default: {
    dialect: "sqlite",
    schema: "./schema.ts",
    out: "./drizzle",
    dbCredentials: { url: ":memory:" },
  },
}));
vi.mock("@saiye/db", async () => {
  const { getInMemoryDB } = await import("@saiye/db/drizzle");
  return { db: getInMemoryDB(true) };
});
vi.mock("@saiye/shared/config", async (importOriginal) => {
  const fs = await import("node:fs");
  // 队列库与镜像文件都落在这个目录下，必须先建好
  fs.mkdirSync(tmpDir, { recursive: true });
  const mod = await importOriginal<typeof import("@saiye/shared/config")>();
  return {
    default: {
      ...mod.default,
      dataDir: tmpDir,
      mirrorExport: { enabled: true, dir: `${tmpDir}/export` },
    },
  };
});
vi.mock("@saiye/shared/inference", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@saiye/shared/inference")>();
  return {
    ...mod,
    InferenceClientFactory: { build: () => inferenceState.client },
  };
});
vi.mock("metrics", () => ({
  workerStatsCounter: { labels: () => ({ inc: vi.fn() }) },
}));
vi.mock("workerTracing", () => ({
  withWorkerTracing: (_name: string, fn: unknown) => fn,
  withWorkerEventLog: (_name: string, fn: unknown) => fn,
}));
vi.mock("@saiye/shared/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  throttledLogger: () => vi.fn(),
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
import serverConfig from "@saiye/shared/config";
import {
  ConceptCompilationQueue,
  MirrorExportQueue,
  prepareQueue,
  triggerConceptCompilation,
} from "@saiye/shared-server";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";

import { ConceptWorker } from "./conceptWorker";
import { reconcileConceptPages } from "./reconcile";
import { MirrorExportWorker } from "../mirrorWorker";
import { conceptFilePath } from "../mirrorExport";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

async function seedUser() {
  const id = nextId("user");
  await db.insert(users).values({ id, name: id, email: `${id}@test.local` });
  return id;
}

async function seedTag(userId: string, name: string) {
  const [row] = await db
    .insert(bookmarkTags)
    .values({ userId, name })
    .returning({ id: bookmarkTags.id });
  return row.id;
}

async function seedList(userId: string, name: string) {
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
  } = {},
) {
  const id = nextId("bm");
  await db.insert(bookmarks).values({
    id,
    userId,
    type: BookmarkTypes.LINK,
    title: opts.title ?? null,
    source: "api",
    archived: false,
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
  opts: { title?: string | null; text?: string | null } = {},
) {
  const id = nextId("bm");
  await db.insert(bookmarks).values({
    id,
    userId,
    type: BookmarkTypes.TEXT,
    title: opts.title ?? null,
    source: "api",
  });
  await db.insert(bookmarkTexts).values({
    id,
    text: opts.text ?? null,
    sourceUrl: null,
  });
  return id;
}

async function attachTag(bookmarkId: string, tagId: string) {
  await db
    .insert(tagsOnBookmarks)
    .values({ bookmarkId, tagId, attachedBy: "human" });
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

async function getPage(conceptId: string) {
  const page = await db.query.conceptPages.findFirst({
    where: eq(conceptPages.id, conceptId),
  });
  assert(page, `concept page ${conceptId} should exist`);
  return page;
}

function mirrorPath(userId: string, slug: string) {
  return conceptFilePath(serverConfig.mirrorExport.dir, userId, slug);
}

let conceptRunner: Awaited<ReturnType<typeof ConceptWorker.build>>;
let mirrorRunner: Awaited<ReturnType<typeof MirrorExportWorker.build>>;

// 与生产启动序列一致：加载插件 → 建队列库 → 注册队列 → 装配 runner
beforeAll(async () => {
  await prepareQueue();
  await ConceptCompilationQueue.ensureInit();
  await MirrorExportQueue.ensureInit();
  conceptRunner = await ConceptWorker.build();
  mirrorRunner = await MirrorExportWorker.build();
}, 60_000);

afterAll(async () => {
  // Windows 下 better-sqlite3 句柄未关闭会导致清理 EBUSY：
  // 尽力关闭 queue.db 句柄后再删临时目录，失败不影响测试结果
  try {
    const { getQueueClient } = await import("@saiye/shared/queueing");
    const client = (await getQueueClient()) as unknown as {
      db?: { session?: { client?: { close?: () => void } } };
    };
    client.db?.session?.client?.close?.();
  } catch {
    // best-effort
  }
  await fsp
    .rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
    .catch(() => undefined);
});

beforeEach(async () => {
  inferenceState.client = null;
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
});

describe("概念页全链路集成", () => {
  test(
    "端到端编译：入队 → worker 编译落库 → 镜像 worker 落盘 Markdown",
    { timeout: 30_000 },
    async () => {
      const userId = await seedUser();
      const tagId = await seedTag(userId, "Rust");
      const bm1 = await seedLinkBookmark(userId, {
        title: "文章一",
        htmlContent: "<p>所有权是 Rust 的核心概念</p>",
      });
      const bm2 = await seedTextBookmark(userId, {
        title: "笔记二",
        text: "生命周期标注笔记",
      });
      await attachTag(bm1, tagId);
      await attachTag(bm2, tagId);
      const conceptId = await seedConceptPage(userId, "tag", tagId);

      const inferFromText = vi.fn().mockResolvedValue({
        response: "## 核心概念\n综述正文 [1]。",
        totalTokens: 99,
      });
      inferenceState.client = { inferFromText };

      await triggerConceptCompilation(conceptId);
      await conceptRunner.runUntilEmpty?.();
      await mirrorRunner.runUntilEmpty?.();

      // 数据库断言
      const page = await getPage(conceptId);
      expect(page.status).toBe("ready");
      expect(page.title).toBe("Rust");
      expect(page.content).toContain("综述正文");
      expect(page.sourceCount).toBe(2);
      expect(page.compileVersion).toBe(1);
      expect(page.lastCompiledAt).not.toBeNull();
      expect(page.lastError).toBeNull();
      expect(inferFromText).toHaveBeenCalledTimes(1);

      const sources = await db.query.conceptPageSources.findMany({
        where: eq(conceptPageSources.pageId, conceptId),
      });
      expect(sources.map((s) => s.bookmarkId).sort()).toEqual(
        [bm1, bm2].sort(),
      );

      // 磁盘镜像断言
      const doc = await fsp.readFile(mirrorPath(userId, page.slug), "utf8");
      expect(doc).toContain('type: "concept"');
      expect(doc).toContain('title: "Rust"');
      expect(doc).toContain('status: "ready"');
      expect(doc).toContain("# Rust");
      expect(doc).toContain("综述正文");
      expect(doc).toContain("## Sources");
      expect(doc).toContain(`](../${bm1}.md)`);
      expect(doc).toContain(`](../${bm2}.md)`);
    },
  );

  test(
    "无来源锚点：编译为空内容、不调用推理、镜像写「尚未编译」占位",
    { timeout: 30_000 },
    async () => {
      const userId = await seedUser();
      const tagId = await seedTag(userId, "空标签");
      const conceptId = await seedConceptPage(userId, "tag", tagId);

      const inferFromText = vi.fn();
      inferenceState.client = { inferFromText };

      await triggerConceptCompilation(conceptId);
      await conceptRunner.runUntilEmpty?.();
      await mirrorRunner.runUntilEmpty?.();

      const page = await getPage(conceptId);
      expect(page.status).toBe("ready");
      expect(page.content).toBe("");
      expect(page.sourceCount).toBe(0);
      expect(inferFromText).not.toHaveBeenCalled();

      const doc = await fsp.readFile(mirrorPath(userId, page.slug), "utf8");
      expect(doc).toContain("_（尚未编译）_");
    },
  );

  test(
    "推理持续失败：重试耗尽（1+2 次）后标记 failure，旧内容与版本保留",
    { timeout: 30_000 },
    async () => {
      const userId = await seedUser();
      const tagId = await seedTag(userId, "失败标签");
      const bm = await seedLinkBookmark(userId, {
        title: "材料",
        htmlContent: "<p>正文</p>",
      });
      await attachTag(bm, tagId);
      const conceptId = await seedConceptPage(userId, "tag", tagId, {
        status: "ready",
        content: "旧版综述",
        compileVersion: 1,
        sourceCount: 1,
        sourceContentHash: "stale-hash",
      });

      const inferFromText = vi.fn().mockRejectedValue(new Error("LLM 500"));
      inferenceState.client = { inferFromText };

      await triggerConceptCompilation(conceptId);
      await conceptRunner.runUntilEmpty?.();

      const page = await getPage(conceptId);
      expect(page.status).toBe("failure");
      expect(page.lastError).toContain("LLM 500");
      expect(page.content).toBe("旧版综述");
      expect(page.compileVersion).toBe(1);
      expect(inferFromText).toHaveBeenCalledTimes(3);
    },
  );

  test(
    "未配置推理客户端：任务正常完成但页面标记 failure（不重试）",
    { timeout: 30_000 },
    async () => {
      inferenceState.client = null;
      const userId = await seedUser();
      const tagId = await seedTag(userId, "任意");
      const bm = await seedTextBookmark(userId, { title: "材料", text: "x" });
      await attachTag(bm, tagId);
      const conceptId = await seedConceptPage(userId, "tag", tagId);

      await triggerConceptCompilation(conceptId);
      await conceptRunner.runUntilEmpty?.();

      const page = await getPage(conceptId);
      expect(page.status).toBe("failure");
      expect(page.lastError).toMatch(/No inference client/);
      expect(page.content).toBe("");
    },
  );

  test(
    "锚点删除：reconcile 删除页面并入队镜像删除，磁盘文件随之消失",
    { timeout: 30_000 },
    async () => {
      const userId = await seedUser();
      const tagId = await seedTag(userId, "将删除");
      const conceptId = await seedConceptPage(userId, "tag", tagId);

      // 先编译 + 导出，确保镜像文件存在
      inferenceState.client = {
        inferFromText: vi
          .fn()
          .mockResolvedValue({ response: "## 综述", totalTokens: 1 }),
      };
      await triggerConceptCompilation(conceptId);
      await conceptRunner.runUntilEmpty?.();
      await mirrorRunner.runUntilEmpty?.();
      const { slug } = await getPage(conceptId);
      const filePath = mirrorPath(userId, slug);
      expect(await fsp.stat(filePath)).toBeDefined();

      // 删除锚点 → 对账：删页 + 镜像删除入队
      await db.delete(bookmarkTags).where(eq(bookmarkTags.id, tagId));
      const result = await reconcileConceptPages();
      expect(result.deleted).toBe(1);
      expect(
        await db.query.conceptPages.findFirst({
          where: eq(conceptPages.id, conceptId),
        }),
      ).toBeUndefined();

      // 镜像 worker 跑空 → 文件消失
      await mirrorRunner.runUntilEmpty?.();
      expect(await fsp.stat(filePath).catch(() => null)).toBeNull();
    },
  );

  test(
    "增量对账联动：新增来源书签 → reconcile 检出 stale 入队 → 重编译更新镜像",
    { timeout: 30_000 },
    async () => {
      const userId = await seedUser();
      const tagId = await seedTag(userId, "增量");
      const bm1 = await seedTextBookmark(userId, { title: "初始", text: "一" });
      await attachTag(bm1, tagId);
      const conceptId = await seedConceptPage(userId, "tag", tagId);

      // 首次编译
      inferenceState.client = {
        inferFromText: vi
          .fn()
          .mockResolvedValue({ response: "## v1", totalTokens: 1 }),
      };
      await triggerConceptCompilation(conceptId);
      await conceptRunner.runUntilEmpty?.();
      await mirrorRunner.runUntilEmpty?.();
      expect((await getPage(conceptId)).sourceCount).toBe(1);

      // 新增一条挂同一标签的书签 → 来源指纹变化
      const bm2 = await seedTextBookmark(userId, { title: "新增", text: "二" });
      await attachTag(bm2, tagId);
      const result = await reconcileConceptPages();
      expect(result.requeued).toBe(1);
      expect((await getPage(conceptId)).status).toBe("stale");

      // 换新脚本重编译 → 版本推进、镜像更新
      inferenceState.client = {
        inferFromText: vi
          .fn()
          .mockResolvedValue({ response: "## v2", totalTokens: 2 }),
      };
      await conceptRunner.runUntilEmpty?.();
      await mirrorRunner.runUntilEmpty?.();

      const page = await getPage(conceptId);
      expect(page.status).toBe("ready");
      expect(page.sourceCount).toBe(2);
      expect(page.content).toContain("v2");
      expect(page.compileVersion).toBe(2);

      const doc = await fsp.readFile(mirrorPath(userId, page.slug), "utf8");
      expect(doc).toContain("v2");
      expect(doc).toContain(`](../${bm2}.md)`);
    },
  );

  test(
    "list 锚点端到端：清单内书签参与编译，镜像含清单名",
    { timeout: 30_000 },
    async () => {
      const userId = await seedUser();
      const listId = await seedList(userId, "阅读清单");
      const bm = await seedLinkBookmark(userId, {
        title: "清单文章",
        htmlContent: "<p>内容</p>",
      });
      await db.insert(bookmarksInLists).values({ bookmarkId: bm, listId });
      const conceptId = await seedConceptPage(userId, "list", listId);

      inferenceState.client = {
        inferFromText: vi
          .fn()
          .mockResolvedValue({ response: "## 清单综述", totalTokens: 3 }),
      };
      await triggerConceptCompilation(conceptId);
      await conceptRunner.runUntilEmpty?.();
      await mirrorRunner.runUntilEmpty?.();

      const page = await getPage(conceptId);
      expect(page.status).toBe("ready");
      expect(page.title).toBe("阅读清单");
      expect(page.sourceCount).toBe(1);

      const doc = await fsp.readFile(mirrorPath(userId, page.slug), "utf8");
      expect(doc).toContain("阅读清单");
      expect(doc).toContain(`](../${bm}.md)`);
    },
  );
});
