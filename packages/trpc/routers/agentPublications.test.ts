import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { agentPublications, consultationUsages } from "@saiye/db/schema";

import { DELISTING_GRACE_PERIOD_MS } from "./agentPublications";
import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

async function createProfile(
  caller: CustomTestContext["apiCallers"][number],
  overrides: Record<string, unknown> = {},
) {
  return caller.agentProfiles.create({
    name: "Rust 专家",
    type: "openai-compatible",
    apiKey: "sk-test",
    baseUrl: "http://localhost:9999",
    model: "test-model",
    ...overrides,
  });
}

describe("Agent Publications Routes", () => {
  test<CustomTestContext>("publish → delist（缓冲期）→ restore → delist 到期 → delisted → 复活 全状态机", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0].agentPublications;
    const profile = await createProfile(apiCallers[0]);

    const created = await api.publish({
      agentProfileId: profile.id,
      title: "Rust 语言咨询",
      tags: ["rust", "系统编程"],
      pricePerCall: 10,
    });
    expect(created.publication.status).toEqual("published");
    expect(created.publication.pricePerCall).toEqual(10);

    // 已发布：list/discover 可见
    expect((await api.list()).publications.length).toEqual(1);
    let discovered = await api.discover();
    expect(discovered.publications[0]!.status).toEqual("published");
    expect(discovered.publications[0]!.ownerName.length).toBeGreaterThan(0);

    // update 元数据（仅 published 可改）
    const updated = await api.update({
      id: created.publication.id,
      pricePerCall: 20,
    });
    expect(updated.publication.pricePerCall).toEqual(20);

    // 下架 → 缓冲期
    const delisted = await api.delist({ id: created.publication.id });
    expect(delisted.publication.status).toEqual("delisting");
    expect(delisted.publication.delistingAt).not.toBeNull();

    // discover 仍可见（下架中），并给出缓冲期截止时间
    discovered = await api.discover();
    expect(discovered.publications[0]!.status).toEqual("delisting");
    expect(discovered.publications[0]!.graceEndsAt).not.toBeNull();
    // delisting 状态不可 update
    await expect(
      api.update({ id: created.publication.id, title: "x" }),
    ).rejects.toThrowError(/Only published/i);

    // 缓冲期内恢复
    const restored = await api.restore({ id: created.publication.id });
    expect(restored.publication.status).toEqual("published");
    expect(restored.publication.delistingAt).toBeNull();

    // 再次下架，并把 delistingAt 篡改为 8 天前（超出 7 天缓冲期）
    await api.delist({ id: created.publication.id });
    await db
      .update(agentPublications)
      .set({
        delistingAt: new Date(Date.now() - DELISTING_GRACE_PERIOD_MS - 1),
      })
      .where(eq(agentPublications.id, created.publication.id));

    // 读路径惰性结算：discover 触发 delisted 转换，随后不可见
    discovered = await api.discover();
    expect(discovered.publications.length).toEqual(0);
    // 到期后 restore 被拒绝
    await expect(
      api.restore({ id: created.publication.id }),
    ).rejects.toThrowError(/Only delisting/i);
    // get 对 delisted 返回 NOT_FOUND
    await expect(api.get({ id: created.publication.id })).rejects.toThrowError(
      /not found/i,
    );

    // delisted 后可复活（复用同一行）
    const revived = await api.publish({
      agentProfileId: profile.id,
      title: "Rust 语言咨询（重新上架）",
    });
    expect(revived.publication.status).toEqual("published");
    expect(revived.publication.id).toEqual(created.publication.id);
  });

  test<CustomTestContext>("同一档案重复发布返回 CONFLICT", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].agentPublications;
    const profile = await createProfile(apiCallers[0]);

    await api.publish({ agentProfileId: profile.id, title: "A" });
    await expect(
      api.publish({ agentProfileId: profile.id, title: "B" }),
    ).rejects.toThrowError(/already published/i);
  });

  test<CustomTestContext>("发布未配置 apiKey 的档案（导入路径）被拒绝", async ({
    apiCallers,
  }) => {
    // importAsset 导入的 openai-compatible 档案 apiKey 为空，是 publish 校验的真实拦截对象
    const source = await createProfile(apiCallers[0]);
    const envelope = await apiCallers[0].agentProfiles.exportAsset({
      id: source.id,
    });
    const imported = await apiCallers[0].agentProfiles.importAsset({
      envelope,
    });
    expect(imported.needsApiKey).toEqual(true);

    await expect(
      apiCallers[0].agentPublications.publish({
        agentProfileId: imported.id,
        title: "无密钥",
      }),
    ).rejects.toThrowError(/no API key/i);
  });

  test<CustomTestContext>("跨用户：发布归属隔离，卡片对咨询者可见", async ({
    apiCallers,
  }) => {
    const profile = await createProfile(apiCallers[0]);
    const created = await apiCallers[0].agentPublications.publish({
      agentProfileId: profile.id,
      title: "仅所有者可管理",
    });

    // 其他用户不能管理
    await expect(
      apiCallers[1].agentPublications.delist({ id: created.publication.id }),
    ).rejects.toThrowError(/not found/i);
    await expect(
      apiCallers[1].agentPublications.restore({ id: created.publication.id }),
    ).rejects.toThrowError(/not found/i);
    await expect(
      apiCallers[1].agentPublications.update({
        id: created.publication.id,
        title: "篡改",
      }),
    ).rejects.toThrowError(/not found/i);

    // 但咨询者可以发现并读取卡片
    const discovered = await apiCallers[1].agentPublications.discover();
    expect(discovered.publications.map((p) => p.id)).toContain(
      created.publication.id,
    );
    const card = await apiCallers[1].agentPublications.get({
      id: created.publication.id,
    });
    expect(card.publication.ownerName.length).toBeGreaterThan(0);

    // 不能发布别人的档案
    await expect(
      apiCallers[1].agentPublications.publish({
        agentProfileId: profile.id,
        title: "冒名",
      }),
    ).rejects.toThrowError(/not found/i);

    // 咨询者自己的 list 为空
    expect(
      (await apiCallers[1].agentPublications.list()).publications.length,
    ).toEqual(0);
  });

  test<CustomTestContext>("agentProfiles.delete 被活跃发布阻止，delisted 后放行", async ({
    apiCallers,
    db,
  }) => {
    const profile = await createProfile(apiCallers[0]);
    const created = await apiCallers[0].agentPublications.publish({
      agentProfileId: profile.id,
      title: "受保护",
    });

    // published 状态阻止删除
    await expect(
      apiCallers[0].agentProfiles.delete({ id: profile.id }),
    ).rejects.toThrowError(/published as a domain expert/i);

    // 下架中仍阻止
    await apiCallers[0].agentPublications.delist({
      id: created.publication.id,
    });
    await expect(
      apiCallers[0].agentProfiles.delete({ id: profile.id }),
    ).rejects.toThrowError(/published as a domain expert/i);

    // 篡改到期并触发结算 → delisted 后放行
    await db
      .update(agentPublications)
      .set({
        delistingAt: new Date(Date.now() - DELISTING_GRACE_PERIOD_MS - 1),
      })
      .where(eq(agentPublications.id, created.publication.id));
    await apiCallers[0].agentPublications.list();

    const res = await apiCallers[0].agentProfiles.delete({
      id: profile.id,
    });
    expect(res.success).toEqual(true);
  });
});

describe("Consultation Usage Query (F3)", () => {
  test<CustomTestContext>("所有者查计量列表 + 汇总 + 分页；非所有者不可见", async ({
    apiCallers,
    db,
  }) => {
    const profile = await createProfile(apiCallers[0]);
    const { publication } = await apiCallers[0].agentPublications.publish({
      agentProfileId: profile.id,
      title: "Rust 咨询",
      pricePerCall: 10,
    });
    // 咨询者建会话后灌 3 笔账（绕开 LLM）
    const session = await apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    for (const amount of [10, 20, 30]) {
      await db.insert(consultationUsages).values({
        publicationId: publication.id,
        consulteeUserId: session.userId,
        sessionId: session.id,
        amount,
      });
    }

    // 所有者：全量 + 汇总
    const page1 = await apiCallers[0].agentPublications.usages({
      id: publication.id,
      limit: 2,
    });
    expect(page1.usages).toHaveLength(2);
    expect(page1.nextCursor).toBe(2);
    expect(page1.totalCredits).toBe(60);
    expect(page1.totalCount).toBe(3);
    expect(page1.usages[0]!.sessionId).toBe(session.id);
    expect(page1.usages[0]!.consulteeUserId).toBe(session.userId);

    // 翻页取余
    const page2 = await apiCallers[0].agentPublications.usages({
      id: publication.id,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.usages).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // 非所有者：NOT_FOUND（不泄露存在性）
    await expect(
      apiCallers[1].agentPublications.usages({ id: publication.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Consultation Settlement (F4)", () => {
  test<CustomTestContext>("结算打包未结算 usage 并标记；无待结时报错；非所有者不可见", async ({
    apiCallers,
    db,
  }) => {
    const profile = await createProfile(apiCallers[0]);
    const { publication } = await apiCallers[0].agentPublications.publish({
      agentProfileId: profile.id,
      title: "Rust 咨询",
      pricePerCall: 10,
    });
    const session = await apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    for (const amount of [10, 20]) {
      await db.insert(consultationUsages).values({
        publicationId: publication.id,
        consulteeUserId: session.userId,
        sessionId: session.id,
        amount,
      });
    }

    // 结算前：全部未结算
    const before = await apiCallers[0].agentPublications.usages({
      id: publication.id,
    });
    expect(before.usages.every((u) => u.settlementId === null)).toBe(true);

    // 结算：汇总 30 / 2 笔
    const { settlement } = await apiCallers[0].agentPublications.settle({
      id: publication.id,
    });
    expect(settlement.amount).toBe(30);
    expect(settlement.usageCount).toBe(2);

    // 结算后：usage 均已标记
    const after = await apiCallers[0].agentPublications.usages({
      id: publication.id,
    });
    expect(after.usages.every((u) => u.settlementId === settlement.id)).toBe(
      true,
    );

    // 无待结 usage：BAD_REQUEST
    await expect(
      apiCallers[0].agentPublications.settle({ id: publication.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // 结算单列表
    const { settlements } = await apiCallers[0].agentPublications.settlements({
      id: publication.id,
    });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.id).toBe(settlement.id);

    // 非所有者：NOT_FOUND
    await expect(
      apiCallers[1].agentPublications.settle({ id: publication.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
