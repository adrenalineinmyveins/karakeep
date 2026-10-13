import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { agentMessages, agentProfiles, users } from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach, getTestQueueMocks } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

/** 用户 0 发布一个 hosted 个人 Agent */
async function publishHostedAgent(
  caller: CustomTestContext["apiCallers"][number],
) {
  const { profileId, publication } = await caller.agentProfiles.publishAsAgent({
    name: "我的知识管家",
    systemPrompt: "你是一个严谨的知识管理助手",
    title: "知识管家",
    tags: ["知识管理"],
  });
  return { profileId, publicationId: publication.id };
}

describe("Hosted 个人 Agent（PR-1）", () => {
  test<CustomTestContext>("hosted 档案创建/落库：无连接字段，可一键发布", async ({
    apiCallers,
    db,
  }) => {
    const { profileId, publicationId } = await publishHostedAgent(
      apiCallers[0],
    );
    expect(profileId).toBeTruthy();
    expect(publicationId).toBeTruthy();

    // 落库校验：hosted 型连接字段全空
    const [profile] = await db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.id, profileId));
    expect(profile!.type).toEqual("hosted");
    expect(profile!.baseUrl).toBeNull();
    expect(profile!.apiKey).toBeNull();
    expect(profile!.command).toBeNull();
    expect(profile!.systemPrompt).toContain("知识管理助手");
  });
});

describe("Agent Messages Routes（PR-4）", () => {
  test<CustomTestContext>("send：hosted 目标可发起，双视角信箱可见", async ({
    apiCallers,
    db,
  }) => {
    const { publicationId } = await publishHostedAgent(apiCallers[0]);

    const { message } = await apiCallers[1].agentMessages.send({
      targetPublicationId: publicationId,
      question: "帮我总结一下知识管理的最佳实践",
    });
    expect(message.state).toEqual("pending");
    expect(message.answer).toBeNull();
    expect(message.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // 入队被调用（worker 侧执行不在本测试范围）
    expect(getTestQueueMocks().agentMessageEnqueue).toHaveBeenCalled();

    // 发起方视角
    const outgoing = await apiCallers[1].agentMessages.listOutgoing({});
    expect(outgoing.messages.length).toEqual(1);
    expect(outgoing.messages[0]!.question).toContain("知识管理");

    // 目标方（发布所有者）收件箱视角
    const incoming = await apiCallers[0].agentMessages.listIncoming({});
    expect(incoming.messages.length).toEqual(1);

    // 无关用户两个视角均不可见
    expect(
      (await apiCallers[2].agentMessages.listOutgoing({})).messages.length,
    ).toEqual(0);
    expect(
      (await apiCallers[2].agentMessages.listIncoming({})).messages.length,
    ).toEqual(0);

    // 直接查库校验影子会话尚未创建（执行期才建）
    const [row] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, message.id));
    expect(row!.sessionId).toBeNull();
  });

  test<CustomTestContext>("send：trae-cli 目标不支持异步咨询", async ({
    apiCallers,
  }) => {
    const profile = await apiCallers[0].agentProfiles.create({
      name: "CLI 专家",
      type: "trae-cli",
      command: "traecli",
    });
    const { publication } = await apiCallers[0].agentPublications.publish({
      agentProfileId: profile.id,
      title: "CLI 专家",
    });
    await expect(
      apiCallers[1].agentMessages.send({
        targetPublicationId: publication.id,
        question: "hello",
      }),
    ).rejects.toThrowError(/does not support async consultation/i);
  });

  test<CustomTestContext>("send：不能咨询自己的发布（与同步会话一致）", async ({
    apiCallers,
  }) => {
    const { publicationId } = await publishHostedAgent(apiCallers[0]);
    await expect(
      apiCallers[0].agentMessages.send({
        targetPublicationId: publicationId,
        question: "自问自答",
      }),
    ).rejects.toThrowError(/Cannot consult your own publication/i);
  });

  test<CustomTestContext>("send：每小时限流生效", async ({
    apiCallers,
    db,
  }) => {
    const { publicationId } = await publishHostedAgent(apiCallers[0]);

    // 直接灌满限流额度（近 1 小时内的历史消息；requester 用真实用户避免外键失败）
    const limit = serverConfig.consultation.agentMessageHourlyLimit;
    const realUsers = await db.select({ id: users.id }).from(users);
    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(agentMessages).values(
      Array.from({ length: limit }, (_, i) => ({
        requesterUserId: realUsers[i % realUsers.length]!.id,
        targetPublicationId: publicationId,
        question: `filler-${i}`,
        state: "answered" as const,
        answer: "ok",
        expiresAt,
      })),
    );

    await expect(
      apiCallers[1].agentMessages.send({
        targetPublicationId: publicationId,
        question: "被限流的请求",
      }),
    ).rejects.toThrowError(/too many consultations/i);
  });

  test<CustomTestContext>("retry：failed 可重试，answered 不可", async ({
    apiCallers,
    db,
  }) => {
    const { publicationId } = await publishHostedAgent(apiCallers[0]);
    const { message } = await apiCallers[1].agentMessages.send({
      targetPublicationId: publicationId,
      question: "会失败的问题",
    });

    // 模拟 worker 执行失败
    await db
      .update(agentMessages)
      .set({ state: "failed", note: "boom" })
      .where(eq(agentMessages.id, message.id));

    const retried = await apiCallers[1].agentMessages.retry({ id: message.id });
    expect(retried.message.state).toEqual("pending");
    expect(retried.message.note).toBeNull();

    // answered 状态不可重试
    await db
      .update(agentMessages)
      .set({ state: "answered", answer: "done" })
      .where(eq(agentMessages.id, message.id));
    await expect(
      apiCallers[1].agentMessages.retry({ id: message.id }),
    ).rejects.toThrowError(/Only failed or expired/i);
  });

  test<CustomTestContext>("discover：runtime 字段区分个人 Agent 与外部专家", async ({
    apiCallers,
  }) => {
    await publishHostedAgent(apiCallers[0]);
    const external = await apiCallers[0].agentProfiles.create({
      name: "外部专家",
      type: "openai-compatible",
      apiKey: "sk-test",
      baseUrl: "http://localhost:9999",
      model: "test-model",
    });
    await apiCallers[0].agentPublications.publish({
      agentProfileId: external.id,
      title: "外部模型专家",
    });

    const discovered = await apiCallers[1].agentPublications.discover(null);
    const runtimes = discovered.publications.map((p) => p.runtime).sort();
    expect(runtimes).toEqual(["hosted", "openai-compatible"]);
    // isOwn：他人的发布对咨询者为 false；发布者自己视角为 true
    expect(discovered.publications.every((p) => p.isOwn === false)).toBe(true);
    const asOwner = await apiCallers[0].agentPublications.discover(null);
    expect(asOwner.publications.every((p) => p.isOwn === true)).toBe(true);

    // 搜索过滤
    const filtered = await apiCallers[1].agentPublications.discover({
      query: "外部",
    });
    expect(filtered.publications.length).toEqual(1);
    expect(filtered.publications[0]!.runtime).toEqual("openai-compatible");
  });
});
