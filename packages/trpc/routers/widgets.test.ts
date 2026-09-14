import { beforeEach, describe, expect, test } from "vitest";

import { zWidgetManifestSchema } from "@saiye/shared/types/widgets";
import type {
  ZWidgetManifest,
  ZWidgetPermission,
} from "@saiye/shared/types/widgets";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

const VALID_CODE = `<div id="root"></div>
<script>
  const el = document.getElementById("root");
  saiye.bookmarks.recent({ days: 7 }).then((list) => {
    el.textContent = "本周保存：" + list.length;
  });
</script>`;

function manifest(permissions: ZWidgetPermission[] = []): ZWidgetManifest {
  return { apiVersion: 1, size: "md", permissions };
}

describe("Widgets Routes", () => {
  test<CustomTestContext>("save creates draft widget with version 1", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const created = await api.save({
      name: "周统计卡",
      description: "显示本周保存书签数",
      manifest: manifest(["bookmarks:read"]),
      code: VALID_CODE,
    });

    expect(created.version).toEqual(1);

    const list = await api.list();
    expect(list.length).toEqual(1);
    expect(list[0].id).toEqual(created.id);
    expect(list[0].status).toEqual("draft");

    const detail = await api.get({ widgetId: created.id });
    expect(detail.code).toEqual(VALID_CODE);
    expect(detail.currentVersion).toEqual(1);

    const versions = await api.listVersions({ widgetId: created.id });
    expect(versions.map((v) => v.version)).toEqual([1]);
  });

  test<CustomTestContext>("manifest with all 9 v1 permissions round-trips (W1)", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const allPermissions: ZWidgetPermission[] = [
      "bookmarks:read",
      "tags:read",
      "lists:read",
      "bookmarks:write",
      "tags:write",
      "lists:write",
      "bookmarks:delete",
      "tags:delete",
      "lists:delete",
    ];

    const created = await api.save({
      name: "全权限组件",
      manifest: manifest(allPermissions),
      code: VALID_CODE,
    });
    expect(created.version).toEqual(1);

    const detail = await api.get({ widgetId: created.id });
    const stored = zWidgetManifestSchema.parse(detail.manifest);
    expect([...stored.permissions].sort()).toEqual([...allPermissions].sort());

    // 枚举外的权限值在服务端校验层直接拒绝
    await expect(() =>
      api.save({
        name: "坏权限",
        manifest: manifest(["bookmarks:admin"] as never),
        code: VALID_CODE,
      }),
    ).rejects.toThrow();
  });

  test<CustomTestContext>("lint rejects forbidden code", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;

    await expect(() =>
      api.save({
        name: "外链组件",
        manifest: manifest(),
        code: `<script src="https://evil.example.com/x.js"></script>`,
      }),
    ).rejects.toThrow(/lint failed/);

    await expect(() =>
      api.save({
        name: "网络请求组件",
        manifest: manifest(),
        code: `<script>fetch("/api/steal").then(r => r.json())</script>`,
      }),
    ).rejects.toThrow(/lint failed/);

    // 全部被拒：库里没有残留
    expect((await api.list()).length).toEqual(0);
  });

  test<CustomTestContext>("invalid manifest is rejected", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;

    // apiVersion 非法：tRPC 输入校验层直接拒绝（类型上故意违反，运行时验证）
    await expect(() =>
      api.save({
        name: "坏版本号",
        manifest: { apiVersion: 2, permissions: [] } as never,
        code: VALID_CODE,
      }),
    ).rejects.toThrow(/apiVersion/);
  });

  test<CustomTestContext>("update creates new version and keeps history", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const created = await api.save({
      name: "统计卡",
      manifest: manifest(["bookmarks:read"]),
      code: VALID_CODE,
    });

    // 安装
    await api.setStatus({ widgetId: created.id, status: "enabled" });

    // 迭代：改 code，权限不变 → 新版本，保持 enabled
    const updated = await api.update({
      widgetId: created.id,
      code: VALID_CODE.replace("7", "30"),
    });
    expect(updated.version).toEqual(2);
    expect(updated.reInstallRequired).toEqual(false);

    const detail = await api.get({ widgetId: created.id });
    expect(detail.currentVersion).toEqual(2);
    expect(detail.code).toContain("30");
    expect(detail.status).toEqual("enabled");

    // 历史版本保留（append-only）
    const versions = await api.listVersions({ widgetId: created.id });
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    // 仅改名称不产生新版本
    const renamed = await api.update({ widgetId: created.id, name: "改名" });
    expect(renamed.version).toEqual(2);
    expect((await api.get({ widgetId: created.id })).name).toEqual("改名");
  });

  test<CustomTestContext>("permission expansion forces re-install (D9)", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const created = await api.save({
      name: "统计卡",
      manifest: manifest(["bookmarks:read"]),
      code: VALID_CODE,
    });
    await api.setStatus({ widgetId: created.id, status: "enabled" });

    // 迭代夹带新权限 → 强制回 draft
    const updated = await api.update({
      widgetId: created.id,
      code: VALID_CODE,
      manifest: manifest(["bookmarks:read", "tags:read"]),
    });
    expect(updated.reInstallRequired).toEqual(true);
    expect((await api.get({ widgetId: created.id })).status).toEqual("draft");

    // 重新安装后再次迭代（权限不变）→ 保持 enabled
    await api.setStatus({ widgetId: created.id, status: "enabled" });
    const again = await api.update({
      widgetId: created.id,
      code: VALID_CODE.replace("本周", "最近"),
    });
    expect(again.reInstallRequired).toEqual(false);
    expect((await api.get({ widgetId: created.id })).status).toEqual("enabled");
  });

  test<CustomTestContext>("rollback copies target version as new one", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const created = await api.save({
      name: "统计卡",
      manifest: manifest(["bookmarks:read"]),
      code: "v1-code",
    });
    await api.update({ widgetId: created.id, code: "v2-code" });
    await api.update({ widgetId: created.id, code: "v3-code" });

    // 默认回滚上一版（v2）→ 产生 v4
    const rb = await api.rollback({ widgetId: created.id });
    expect(rb.rolledBackFrom).toEqual(2);
    expect(rb.version).toEqual(4);
    expect(rb.reInstallRequired).toEqual(false);

    const detail = await api.get({ widgetId: created.id });
    expect(detail.code).toEqual("v2-code");
    expect(detail.currentVersion).toEqual(4);

    // 历史不丢：1/2/3/4 全在
    const versions = await api.listVersions({ widgetId: created.id });
    expect(versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);

    // 指定版本回滚（v1）→ v5
    const rb2 = await api.rollback({ widgetId: created.id, version: 1 });
    expect(rb2.version).toEqual(5);
    expect((await api.get({ widgetId: created.id })).code).toEqual("v1-code");

    // 回滚到不存在的版本
    await expect(() =>
      api.rollback({ widgetId: created.id, version: 99 }),
    ).rejects.toThrow(/Rollback target version not found/);
  });

  test<CustomTestContext>("rollback with expanded permissions forces draft (D9)", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const created = await api.save({
      name: "统计卡",
      manifest: manifest(["bookmarks:read", "tags:read"]),
      code: "v1-code",
    });
    // v2 收窄权限
    await api.update({
      widgetId: created.id,
      code: "v2-code",
      manifest: manifest(["bookmarks:read"]),
    });
    await api.setStatus({ widgetId: created.id, status: "enabled" });

    // 回滚到 v1（权限更多）→ 强制回 draft
    const rb = await api.rollback({ widgetId: created.id, version: 1 });
    expect(rb.reInstallRequired).toEqual(true);
    expect((await api.get({ widgetId: created.id })).status).toEqual("draft");
  });

  test<CustomTestContext>("delete removes widget and versions", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].widgets;
    const created = await api.save({
      name: "统计卡",
      manifest: manifest(),
      code: VALID_CODE,
    });
    await api.update({ widgetId: created.id, code: "v2-code" });

    await api.delete({ widgetId: created.id });

    expect((await api.list()).length).toEqual(0);
    await expect(() => api.get({ widgetId: created.id })).rejects.toThrow(
      /Widget not found/,
    );
    // 版本历史随级联删除（widget 已不存在，归属校验直接 NOT_FOUND）
    await expect(() =>
      api.listVersions({ widgetId: created.id }),
    ).rejects.toThrow(/Widget not found/);
  });

  test<CustomTestContext>("privacy between users", async ({ apiCallers }) => {
    const user1Widget = await apiCallers[0].widgets.save({
      name: "User 1 widget",
      manifest: manifest(),
      code: VALID_CODE,
    });

    // 用户 2 看不到、改不了、删不了
    const user2List = await apiCallers[1].widgets.list();
    expect(user2List.length).toEqual(0);

    await expect(() =>
      apiCallers[1].widgets.get({ widgetId: user1Widget.id }),
    ).rejects.toThrow(/Widget not found/);

    await expect(() =>
      apiCallers[1].widgets.update({
        widgetId: user1Widget.id,
        code: "hacked",
      }),
    ).rejects.toThrow(/Widget not found/);

    await expect(() =>
      apiCallers[1].widgets.delete({ widgetId: user1Widget.id }),
    ).rejects.toThrow(/Widget not found/);

    await expect(() =>
      apiCallers[1].widgets.setStatus({
        widgetId: user1Widget.id,
        status: "enabled",
      }),
    ).rejects.toThrow(/Widget not found/);

    // 用户 1 的资产完好
    expect((await apiCallers[0].widgets.list()).length).toEqual(1);
  });
});
