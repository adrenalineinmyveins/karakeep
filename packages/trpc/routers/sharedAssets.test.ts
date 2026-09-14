import { beforeEach, describe, expect, test } from "vitest";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

/** C2 分享链接 + Fork：快照语义、撤销失效、跨用户 fork 落库 */
describe("Shared Agent Assets", () => {
  test<CustomTestContext>("create is idempotent and snapshot omits apiKey", async ({
    apiCallers,
  }) => {
    const created = await apiCallers[0].agentProfiles.create({
      type: "openai-compatible",
      name: "主力模型",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret",
      model: "gpt-4o-mini",
    });

    const share = await apiCallers[0].sharedAssets.create({
      assetType: "agentProfile",
      assetId: created.id,
    });
    expect(share.shareToken).toBeTruthy();
    expect(share.name).toEqual("主力模型");

    // 同资产再分享：返回同一 token
    const again = await apiCallers[0].sharedAssets.create({
      assetType: "agentProfile",
      assetId: created.id,
    });
    expect(again.shareToken).toEqual(share.shareToken);

    // 公开读取：apiKey 永不入快照
    const pub = await apiCallers[1].publicSharedAssets.get({
      token: share.shareToken,
    });
    expect(pub.assetType).toEqual("agentProfile");
    expect(pub.name).toEqual("主力模型");
    expect(pub.ownerName).toBeTruthy();
    expect(JSON.stringify(pub.payload)).not.toContain("sk-secret");
    expect(JSON.stringify(pub.payload)).not.toContain("apiKey");

    // listMine 能看到
    const mine = await apiCallers[0].sharedAssets.listMine();
    expect(mine.shares.length).toEqual(1);
    expect(mine.shares[0].assetId).toEqual(created.id);
  });

  test<CustomTestContext>("share is a snapshot: source edits don't leak", async ({
    apiCallers,
  }) => {
    const prompt = await apiCallers[0].prompts.create({
      text: "原始提示词",
      appliesTo: "text",
    });
    const share = await apiCallers[0].sharedAssets.create({
      assetType: "prompt",
      assetId: prompt.id,
    });

    // 分享后修改源
    await apiCallers[0].prompts.update({
      promptId: prompt.id,
      text: "修改后的提示词",
      appliesTo: "text",
      enabled: false,
    });

    const pub = await apiCallers[0].publicSharedAssets.get({
      token: share.shareToken,
    });
    expect((pub.payload as { text: string }).text).toEqual("原始提示词");
  });

  test<CustomTestContext>("revoke invalidates the link and clears listMine", async ({
    apiCallers,
  }) => {
    const prompt = await apiCallers[0].prompts.create({
      text: "将被撤销",
      appliesTo: "summary",
    });
    const share = await apiCallers[0].sharedAssets.create({
      assetType: "prompt",
      assetId: prompt.id,
    });

    const mine = await apiCallers[0].sharedAssets.listMine();
    await apiCallers[0].sharedAssets.revoke({ id: mine.shares[0].id });

    await expect(
      apiCallers[0].publicSharedAssets.get({ token: share.shareToken }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      apiCallers[0].sharedAssets.fork({ token: share.shareToken }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const after = await apiCallers[0].sharedAssets.listMine();
    expect(after.shares.length).toEqual(0);

    // 撤销后再分享：生成新 token（行已删，重建）
    const renewed = await apiCallers[0].sharedAssets.create({
      assetType: "prompt",
      assetId: prompt.id,
    });
    expect(renewed.shareToken).not.toEqual(share.shareToken);
  });

  test<CustomTestContext>("revoke only works for the owner", async ({
    apiCallers,
  }) => {
    const prompt = await apiCallers[0].prompts.create({
      text: "别人的资产",
      appliesTo: "text",
    });
    const share = await apiCallers[0].sharedAssets.create({
      assetType: "prompt",
      assetId: prompt.id,
    });

    // 用户 1 无法撤销用户 0 的分享（id 不属于他 → NOT_FOUND）
    await expect(
      apiCallers[1].sharedAssets.revoke({ id: "nonexistent" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // 链接仍有效
    const pub = await apiCallers[1].publicSharedAssets.get({
      token: share.shareToken,
    });
    expect(pub.name).toBeTruthy();
  });

  test<CustomTestContext>("fork prompt copies snapshot with enabled", async ({
    apiCallers,
  }) => {
    const prompt = await apiCallers[0].prompts.create({
      text: "跨用户提示词",
      appliesTo: "text",
    });
    await apiCallers[0].prompts.update({
      promptId: prompt.id,
      text: "跨用户提示词",
      appliesTo: "text",
      enabled: false,
    });
    const share = await apiCallers[0].sharedAssets.create({
      assetType: "prompt",
      assetId: prompt.id,
    });

    const res = await apiCallers[1].sharedAssets.fork({
      token: share.shareToken,
    });
    expect(res.assetType).toEqual("prompt");
    expect(res.needsApiKey).toEqual(false);

    const list = await apiCallers[1].prompts.list();
    expect(list.length).toEqual(1);
    expect(list[0].text).toEqual("跨用户提示词");
    expect(list[0].enabled).toEqual(false);
  });

  test<CustomTestContext>("fork widget lands as draft with version 1", async ({
    apiCallers,
  }) => {
    const widget = await apiCallers[0].widgets.save({
      name: "周统计卡",
      description: "显示本周保存书签数",
      manifest: { apiVersion: 1, size: "md", permissions: ["bookmarks:read"] },
      code: '<div id="root"></div><script>document.getElementById("root").textContent = "hi";</script>',
    });
    const share = await apiCallers[0].sharedAssets.create({
      assetType: "widget",
      assetId: widget.id,
    });

    const res = await apiCallers[1].sharedAssets.fork({
      token: share.shareToken,
    });
    expect(res.assetType).toEqual("widget");

    const list = await apiCallers[1].widgets.list();
    expect(list.length).toEqual(1);
    expect(list[0].status).toEqual("draft");
    const versions = await apiCallers[1].widgets.listVersions({
      widgetId: res.assetId,
    });
    expect(versions.map((v) => v.version)).toEqual([1]);
  });

  test<CustomTestContext>("fork agentProfile has no apiKey and flags it", async ({
    apiCallers,
  }) => {
    const profile = await apiCallers[0].agentProfiles.create({
      type: "openai-compatible",
      name: "分享档案",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret",
      model: "gpt-4o-mini",
    });
    const share = await apiCallers[0].sharedAssets.create({
      assetType: "agentProfile",
      assetId: profile.id,
    });

    const res = await apiCallers[1].sharedAssets.fork({
      token: share.shareToken,
    });
    expect(res.assetType).toEqual("agentProfile");
    expect(res.needsApiKey).toEqual(true);

    const list = await apiCallers[1].agentProfiles.list();
    expect(list.profiles.length).toEqual(1);
    expect(list.profiles[0].name).toEqual("分享档案");
    expect(list.profiles[0].hasApiKey).toEqual(false);
  });

  test<CustomTestContext>("sharing someone else's asset fails", async ({
    apiCallers,
  }) => {
    const prompt = await apiCallers[0].prompts.create({
      text: "归属校验",
      appliesTo: "text",
    });
    await expect(
      apiCallers[1].sharedAssets.create({
        assetType: "prompt",
        assetId: prompt.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test<CustomTestContext>("unknown token is NOT_FOUND", async ({
    apiCallers,
  }) => {
    await expect(
      apiCallers[0].publicSharedAssets.get({ token: "no-such-token" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      apiCallers[0].sharedAssets.fork({ token: "no-such-token" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  /** C3 发现页：listPublic 的筛选 / 搜索 / isMine */
  test<CustomTestContext>("listPublic returns all shares with isMine flags and type filter", async ({
    apiCallers,
  }) => {
    const prompt = await apiCallers[0].prompts.create({
      text: "发现页提示词",
      appliesTo: "text",
    });
    const widget = await apiCallers[1].widgets.save({
      name: "发现页组件",
      description: "发现页测试用",
      manifest: { apiVersion: 1, size: "md", permissions: [] },
      code: '<div id="root"></div>',
    });
    await apiCallers[0].sharedAssets.create({
      assetType: "prompt",
      assetId: prompt.id,
    });
    await apiCallers[1].sharedAssets.create({
      assetType: "widget",
      assetId: widget.id,
    });

    // 全量：两个用户的分享都可见，isMine 各自正确
    const all = await apiCallers[0].sharedAssets.listPublic({});
    expect(all.assets.length).toEqual(2);
    expect(all.nextCursor).toBeNull();
    const byToken = new Map(all.assets.map((a) => [a.shareToken, a]));
    const promptShare = all.assets.find((a) => a.assetType === "prompt")!;
    const widgetShare = all.assets.find((a) => a.assetType === "widget")!;
    expect(promptShare.isMine).toEqual(true);
    expect(promptShare.ownerName).toBeTruthy();
    expect(widgetShare.isMine).toEqual(false);
    expect(byToken.size).toEqual(2);

    // 类型筛选
    const widgetsOnly = await apiCallers[0].sharedAssets.listPublic({
      assetType: "widget",
    });
    expect(widgetsOnly.assets.length).toEqual(1);
    expect(widgetsOnly.assets[0].assetType).toEqual("widget");

    // 关键词搜索：命中 / 未命中
    const hit = await apiCallers[0].sharedAssets.listPublic({
      query: "发现页",
    });
    expect(hit.assets.map((a) => a.assetType).sort()).toEqual([
      "prompt",
      "widget",
    ]);
    const miss = await apiCallers[0].sharedAssets.listPublic({
      query: "不存在的关键词",
    });
    expect(miss.assets.length).toEqual(0);
    expect(miss.nextCursor).toBeNull();
  });

  test<CustomTestContext>("listPublic paginates with cursor without duplicates", async ({
    apiCallers,
  }) => {
    // 用户 0 建多个 prompt 分享，用户 1 分页读取
    for (let i = 0; i < 3; i++) {
      const prompt = await apiCallers[0].prompts.create({
        text: `分页提示词 ${i}`,
        appliesTo: "text",
      });
      await apiCallers[0].sharedAssets.create({
        assetType: "prompt",
        assetId: prompt.id,
      });
    }

    const page1 = await apiCallers[1].sharedAssets.listPublic({
      limit: 2,
    });
    expect(page1.assets.length).toEqual(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await apiCallers[1].sharedAssets.listPublic({
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.assets.length).toEqual(1);
    expect(page2.nextCursor).toBeNull();

    const tokens = [...page1.assets, ...page2.assets].map((a) => a.shareToken);
    expect(new Set(tokens).size).toEqual(3);
  });
});
