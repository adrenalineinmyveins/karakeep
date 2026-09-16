import { beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  bookmarkLinks,
  bookmarks,
  conceptPageSources,
  conceptPages,
  users,
} from "@saiye/db/schema";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";

// 概念页创建依赖 inference 配置门控；默认打开，个别用例内关闭
const inferenceState = vi.hoisted(() => ({ configured: true }));
vi.mock("@saiye/shared/config", async (original) => {
  const mod = (await original()) as typeof import("@saiye/shared/config");
  return {
    default: {
      ...mod.default,
      inference: {
        ...mod.default.inference,
        get isConfigured() {
          return inferenceState.configured;
        },
      },
    },
  };
});

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach, getTestQueueMocks } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));
beforeEach(() => {
  inferenceState.configured = true;
});

describe("Concepts Routes", () => {
  test<CustomTestContext>("create → anchorStatus → list → get → recompile → delete 生命周期", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].concepts;
    const { triggerConceptCompilation, triggerConceptMirrorDelete } =
      getTestQueueMocks();
    triggerConceptCompilation.mockClear();
    triggerConceptMirrorDelete.mockClear();

    const tag = await apiCallers[0].tags.create({ name: "rust" });

    const created = await api.create({
      anchorType: "tag",
      anchorId: tag.id,
    });
    expect(created.status).toEqual("pending");
    expect(triggerConceptCompilation).toHaveBeenCalledWith(created.conceptId);

    const status = await api.anchorStatus({
      anchorType: "tag",
      anchorId: tag.id,
    });
    expect(status.conceptId).toEqual(created.conceptId);
    expect(status.status).toEqual("pending");
    expect(status.inferenceConfigured).toEqual(true);

    const list = await api.list();
    expect(list.concepts.map((c) => c.id)).toContain(created.conceptId);

    const detail = await api.get({ slug: created.slug });
    expect(detail.concept.title).toEqual("rust");
    expect(detail.concept.slug).toEqual(created.slug);
    expect(detail.anchorName).toEqual("rust");
    expect(detail.content).toEqual("");

    // 重新编译：pending 状态允许再次入队
    await api.recompile({ conceptId: created.conceptId });
    expect(triggerConceptCompilation).toHaveBeenCalledTimes(2);

    await api.delete({ conceptId: created.conceptId });
    expect(triggerConceptMirrorDelete).toHaveBeenCalledWith(
      expect.any(String),
      created.slug,
    );

    const after = await api.anchorStatus({
      anchorType: "tag",
      anchorId: tag.id,
    });
    expect(after.conceptId).toBeNull();
    expect(after.status).toBeNull();
  });

  test<CustomTestContext>("同一锚点不允许重复创建", async ({ apiCallers }) => {
    const api = apiCallers[0].concepts;
    const tag = await apiCallers[0].tags.create({ name: "go" });

    await api.create({ anchorType: "tag", anchorId: tag.id });
    await expect(
      api.create({ anchorType: "tag", anchorId: tag.id }),
    ).rejects.toThrowError(/already exists/i);
  });

  test<CustomTestContext>("锚点不存在时创建失败", async ({ apiCallers }) => {
    await expect(
      apiCallers[0].concepts.create({
        anchorType: "tag",
        anchorId: "no-such-tag",
      }),
    ).rejects.toThrowError(/not found/i);
  });

  test<CustomTestContext>("概念页按用户隔离", async ({ apiCallers }) => {
    const tag = await apiCallers[0].tags.create({ name: "私有标签" });
    const created = await apiCallers[0].concepts.create({
      anchorType: "tag",
      anchorId: tag.id,
    });

    // 其他用户看不到，也无法按 slug 读取
    const otherStatus = await apiCallers[1].concepts.anchorStatus({
      anchorType: "tag",
      anchorId: tag.id,
    });
    expect(otherStatus.conceptId).toBeNull();

    expect((await apiCallers[1].concepts.list()).concepts.length).toEqual(0);
    await expect(
      apiCallers[1].concepts.get({ slug: created.slug }),
    ).rejects.toThrowError(/not found/i);
    await expect(
      apiCallers[1].concepts.delete({ conceptId: created.conceptId }),
    ).rejects.toThrowError(/not found/i);

    // 原用户不受影响
    expect((await apiCallers[0].concepts.list()).concepts.length).toEqual(1);
  });

  test<CustomTestContext>("同一用户内 slug 冲突时加后缀", async ({
    apiCallers,
  }) => {
    // slug 唯一性按用户隔离；同用户的 tag 与 list 可以同名，slug 需消歧
    const tag = await apiCallers[0].tags.create({ name: "知识管理" });
    const list = await apiCallers[0].lists.create({
      name: "知识管理",
      icon: "📚",
    });

    const fromTag = await apiCallers[0].concepts.create({
      anchorType: "tag",
      anchorId: tag.id,
    });
    const fromList = await apiCallers[0].concepts.create({
      anchorType: "list",
      anchorId: list.id,
    });

    expect(fromTag.slug).toEqual("知识管理");
    expect(fromList.slug).not.toEqual(fromTag.slug);
    expect(fromList.slug).toMatch(/^知识管理-[a-z0-9]+$/);
  });

  test<CustomTestContext>("recompile 在 generating 状态时返回 CONFLICT", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].concepts;
    const tag = await apiCallers[0].tags.create({ name: "busy" });
    const created = await api.create({
      anchorType: "tag",
      anchorId: tag.id,
    });

    await db
      .update(conceptPages)
      .set({ status: "generating" })
      .where(eq(conceptPages.id, created.conceptId));

    await expect(
      api.recompile({ conceptId: created.conceptId }),
    ).rejects.toThrowError(/already in progress/i);

    // 状态不被覆盖回 pending
    const page = await db.query.conceptPages.findFirst({
      where: eq(conceptPages.id, created.conceptId),
    });
    expect(page?.status).toEqual("generating");
  });

  test<CustomTestContext>("get 返回来源书签的标题与链接", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].concepts;
    const tag = await apiCallers[0].tags.create({ name: "溯源" });
    const created = await api.create({
      anchorType: "tag",
      anchorId: tag.id,
    });

    // 直接落一条来源快照（正常由 worker 编译时写入）
    const [user] = await db.select({ id: users.id }).from(users).limit(1);
    const bmId = "bm-source-1";
    await db.insert(bookmarks).values({
      id: bmId,
      userId: user.id,
      type: BookmarkTypes.LINK,
      title: "Rust 官网",
      source: "api",
    });
    await db
      .insert(bookmarkLinks)
      .values({ id: bmId, url: "https://www.rust-lang.org" });
    await db
      .insert(conceptPageSources)
      .values({ pageId: created.conceptId, bookmarkId: bmId });

    const detail = await api.get({ slug: created.slug });
    expect(detail.sources).toEqual([
      {
        bookmarkId: bmId,
        title: "Rust 官网",
        url: "https://www.rust-lang.org",
      },
    ]);
  });

  test<CustomTestContext>("inference 未配置时：create 被门控拒绝，恢复后可创建", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].concepts;
    const tag = await apiCallers[0].tags.create({ name: "离线" });

    inferenceState.configured = false;
    await expect(
      api.create({ anchorType: "tag", anchorId: tag.id }),
    ).rejects.toThrowError(/Inference is not configured/i);
    const status = await api.anchorStatus({
      anchorType: "tag",
      anchorId: tag.id,
    });
    expect(status.inferenceConfigured).toEqual(false);
    expect(status.conceptId).toBeNull();

    inferenceState.configured = true;
    const created = await api.create({
      anchorType: "tag",
      anchorId: tag.id,
    });
    expect(created.status).toEqual("pending");
  });
});
