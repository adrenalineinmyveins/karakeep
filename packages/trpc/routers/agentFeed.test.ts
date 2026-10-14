import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { agentPosts } from "@saiye/db/schema";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

/** 用户发布一个 hosted 专家（进 feed 内容池） */
async function publish(caller: CustomTestContext["apiCallers"][number]) {
  const { profileId, publication } = await caller.agentProfiles.publishAsAgent({
    name: `专家-${Math.random().toString(36).slice(2, 6)}`,
    systemPrompt: "你是领域专家",
    title: "领域专家",
    tags: ["test"],
  });
  return { profileId, publicationId: publication.id };
}

describe("Agent Feed（D6）", () => {
  test<CustomTestContext>("曝光去重验收：连续拉取 3 次零重复，池耗尽返回空页", async ({
    apiCallers,
  }) => {
    // 内容池：2 个专家发布（用户 0/1）+ 2 条动态（用户 0/1）
    await publish(apiCallers[0]);
    await publish(apiCallers[1]);
    const p0 = await apiCallers[0].agentProfiles.create({
      name: "动态作者0",
      type: "hosted",
    });
    const p1 = await apiCallers[1].agentProfiles.create({
      name: "动态作者1",
      type: "hosted",
    });
    await apiCallers[0].agentFeed.createPost({
      profileId: p0.id,
      content: "用户0的Agent动态",
    });
    await apiCallers[1].agentFeed.createPost({
      profileId: p1.id,
      content: "用户1的Agent动态",
    });

    // 用户 2 视角：limit 3 连续拉 3 轮（模拟刷新 3 次）
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const page = await apiCallers[2].agentFeed.feed({ limit: 3 });
      for (const item of page.items) {
        const key = `${item.itemType}:${item.itemId}`;
        // 验收核心：同一轮与跨轮都不允许重复曝光
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }

    // 内容池共 4 条，全部恰好消费一次
    expect(seen.size).toBe(4);
    expect([...seen].filter((k) => k.startsWith("publication:")).length).toBe(
      2,
    );
    expect([...seen].filter((k) => k.startsWith("post:")).length).toBe(2);

    // 池耗尽：再拉返回空页
    const drained = await apiCallers[2].agentFeed.feed({ limit: 3 });
    expect(drained.items).toHaveLength(0);
    expect(drained.nextCursor).toBeNull();
  });

  test<CustomTestContext>("feed 条目形状：publication 带自身 id 可跳转；post 带关联发布 id", async ({
    apiCallers,
  }) => {
    const { publicationId } = await publish(apiCallers[0]);
    const profile = await apiCallers[0].agentProfiles.create({
      name: "跳转作者",
      type: "hosted",
    });
    await apiCallers[0].agentFeed.createPost({
      profileId: profile.id,
      content: "带关联的动态",
      publicationId,
    });

    const page = await apiCallers[2].agentFeed.feed({ limit: 10 });
    expect(page.items).toHaveLength(2);
    const post = page.items.find((i) => i.itemType === "post")!;
    const pub = page.items.find((i) => i.itemType === "publication")!;
    // 验收：Feed 条目可跳转对应 Agent 卡片
    expect(pub.publicationId).toBe(pub.itemId);
    expect(post.publicationId).toBe(publicationId);
    expect(post.title).toBe("跳转作者");
  });

  test<CustomTestContext>("createPost：档案归属校验，他人档案 404", async ({
    apiCallers,
  }) => {
    const mine = await apiCallers[0].agentProfiles.create({
      name: "我的档案",
      type: "hosted",
    });
    const theirs = await apiCallers[1].agentProfiles.create({
      name: "他人档案",
      type: "hosted",
    });

    const { post } = await apiCallers[0].agentFeed.createPost({
      profileId: mine.id,
      content: "合法动态",
    });
    expect(post.content).toBe("合法动态");

    await expect(
      apiCallers[0].agentFeed.createPost({
        profileId: theirs.id,
        content: "冒名动态",
      }),
    ).rejects.toThrowError(/not found/i);
  });

  test<CustomTestContext>("deletePost：非本人删除无效（动态保留）", async ({
    apiCallers,
    db,
  }) => {
    const profile = await apiCallers[0].agentProfiles.create({
      name: "作者",
      type: "hosted",
    });
    const { post } = await apiCallers[0].agentFeed.createPost({
      profileId: profile.id,
      content: "待删除",
    });

    // 用户 1 尝试删用户 0 的动态：无权（不报错但不动库）
    await apiCallers[1].agentFeed.deletePost({ id: post.id });
    let rows = await db
      .select()
      .from(agentPosts)
      .where(eq(agentPosts.id, post.id));
    expect(rows).toHaveLength(1);

    // 本人删除生效
    await apiCallers[0].agentFeed.deletePost({ id: post.id });
    rows = await db.select().from(agentPosts).where(eq(agentPosts.id, post.id));
    expect(rows).toHaveLength(0);
  });

  test<CustomTestContext>("我的动态列表：仅本人可见自己的动态", async ({
    apiCallers,
  }) => {
    const profile0 = await apiCallers[0].agentProfiles.create({
      name: "A",
      type: "hosted",
    });
    const profile1 = await apiCallers[1].agentProfiles.create({
      name: "B",
      type: "hosted",
    });
    await apiCallers[0].agentFeed.createPost({
      profileId: profile0.id,
      content: "A 的动态",
    });
    await apiCallers[1].agentFeed.createPost({
      profileId: profile1.id,
      content: "B 的动态",
    });

    const mine = await apiCallers[0].agentFeed.listMyPosts();
    expect(mine.posts).toHaveLength(1);
    expect(mine.posts[0]!.content).toBe("A 的动态");
  });
});
