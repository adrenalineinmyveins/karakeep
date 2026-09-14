import { beforeEach, describe, expect, test } from "vitest";

import type {
  ZWidgetManifest,
  ZWidgetPermission,
} from "@saiye/shared/types/widgets";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

const WIDGET_CODE = `<div id="root"></div>
<script>
  const el = document.getElementById("root");
  saiye.bookmarks.recent({ days: 7 }).then((list) => {
    el.textContent = "本周保存：" + list.length;
  });
</script>`;

function manifest(permissions: ZWidgetPermission[] = []): ZWidgetManifest {
  return { apiVersion: 1, size: "md", permissions };
}

/** C1 资产导出/导入：三类 agent 配置资产的跨用户流通闭环 */
describe("Asset Export/Import", () => {
  test<CustomTestContext>("agentProfile export omits apiKey; import fork works", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].agentProfiles;
    const created = await api.create({
      type: "openai-compatible",
      name: "主力模型",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret",
      model: "gpt-4o-mini",
      systemPrompt: "你是一个助手",
    });

    const envelope = await api.exportAsset({ id: created.id });
    expect(envelope.type).toEqual("saiye.asset-export");
    expect(envelope.version).toEqual(1);
    expect(envelope.assetType).toEqual("agentProfile");
    // apiKey 永不导出
    expect(JSON.stringify(envelope)).not.toContain("sk-secret");
    expect(JSON.stringify(envelope.data)).not.toContain("apiKey");
    expect(JSON.stringify(envelope.data)).toContain("gpt-4o-mini");

    // 用户 1 导入：字段一致、无 apiKey、提示需补填
    const imported = await apiCallers[1].agentProfiles.importAsset({
      envelope,
    });
    expect(imported.needsApiKey).toEqual(true);

    const list = await apiCallers[1].agentProfiles.list();
    expect(list.profiles.length).toEqual(1);
    const fork = list.profiles[0];
    expect(fork.id).not.toEqual(created.id);
    expect(fork.name).toEqual("主力模型");
    expect(fork.baseUrl).toEqual("https://api.example.com/v1");
    expect(fork.model).toEqual("gpt-4o-mini");
    expect(fork.hasApiKey).toEqual(false);
  });

  test<CustomTestContext>("agentProfile trae-cli import does not need api key", async ({
    apiCallers,
  }) => {
    const created = await apiCallers[0].agentProfiles.create({
      type: "trae-cli",
      name: "本地 CLI",
      command: "traecli",
      timeoutMinutes: 10,
    });
    const envelope = await apiCallers[0].agentProfiles.exportAsset({
      id: created.id,
    });
    const imported = await apiCallers[1].agentProfiles.importAsset({
      envelope,
    });
    expect(imported.needsApiKey).toEqual(false);
  });

  test<CustomTestContext>("widget export/import lands as draft with version 1", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const created = await api.save({
      name: "周统计卡",
      description: "显示本周保存书签数",
      manifest: manifest(["bookmarks:read"]),
      code: WIDGET_CODE,
    });

    const envelope = await api.exportAsset({ widgetId: created.id });
    expect(envelope.assetType).toEqual("widget");
    expect(JSON.parse(JSON.stringify(envelope.data))).toMatchObject({
      name: "周统计卡",
      manifest: manifest(["bookmarks:read"]),
      code: WIDGET_CODE,
    });

    const imported = await apiCallers[1].widgets.importAsset({ envelope });
    expect(imported.version).toEqual(1);

    const list = await apiCallers[1].widgets.list();
    expect(list.length).toEqual(1);
    expect(list[0].status).toEqual("draft");
    expect(list[0].id).not.toEqual(created.id);

    const detail = await apiCallers[1].widgets.get({ widgetId: imported.id });
    expect(detail.code).toEqual(WIDGET_CODE);
    const versions = await apiCallers[1].widgets.listVersions({
      widgetId: imported.id,
    });
    expect(versions.map((v) => v.version)).toEqual([1]);
  });

  test<CustomTestContext>("prompt export/import keeps snapshot fields", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].prompts;
    await api.create({ text: "使用中文标签", appliesTo: "text" });
    const list = await api.list();
    // 禁用后导出，导入应保留 enabled=false（快照语义）
    const disabled = await api.update({
      promptId: list[0].id,
      enabled: false,
    });
    expect(disabled.enabled).toEqual(false);

    const envelope = await api.exportAsset({ promptId: list[0].id });
    expect(envelope.assetType).toEqual("prompt");

    await apiCallers[1].prompts.importAsset({ envelope });
    const forkedList = await apiCallers[1].prompts.list();
    expect(forkedList.length).toEqual(1);
    expect(forkedList[0].text).toEqual("使用中文标签");
    expect(forkedList[0].appliesTo).toEqual("text");
    expect(forkedList[0].enabled).toEqual(false);
  });

  test<CustomTestContext>("envelope assetType mismatch is rejected", async ({
    apiCallers,
  }) => {
    const prompt = await apiCallers[0].prompts.create({
      text: "测试提示词",
      appliesTo: "all_tagging",
    });
    const envelope = await apiCallers[0].prompts.exportAsset({
      promptId: prompt.id,
    });

    // prompt 的文件喂给 agentProfiles 导入 → 拒绝
    await expect(
      apiCallers[1].agentProfiles.importAsset({ envelope }),
    ).rejects.toThrow(/does not contain an agent profile/);

    // widget 的文件喂给 prompts 导入 → 拒绝
    const w = await apiCallers[0].widgets.save({
      name: "卡片",
      manifest: manifest(),
      code: WIDGET_CODE,
    });
    const widgetEnvelope = await apiCallers[0].widgets.exportAsset({
      widgetId: w.id,
    });
    await expect(
      apiCallers[1].prompts.importAsset({ envelope: widgetEnvelope }),
    ).rejects.toThrow(/does not contain a prompt/);
  });

  test<CustomTestContext>("malformed envelope is rejected at input validation", async ({
    apiCallers,
  }) => {
    await expect(
      apiCallers[0].agentProfiles.importAsset({
        envelope: {
          type: "saiye.asset-export",
          version: 2 as never, // 不认识的版本
          assetType: "agentProfile",
          exportedAt: new Date().toISOString(),
          data: {},
        },
      }),
    ).rejects.toThrow();
  });
});
