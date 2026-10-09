import { beforeEach, describe, expect, inject, it } from "vitest";

import { createTestUser } from "../../utils/api";
import { getTrpcClient } from "../../utils/trpc";

// 咨询全链路（D1-D6）：双用户 fixture，LLM 经 aimock 固定回复。
// pricePerCall = SESSION_BILLING_CAP_CREDITS（1000），第一条回复记账后
// 累计即达封顶，第二条被拒 —— 一条链路同时验证计量与封顶。
describe("Consultations E2E (D1-D6)", () => {
  const port = inject("saiyePort");

  if (!port) {
    throw new Error("Missing required environment variables");
  }

  let ownerTrpc: ReturnType<typeof getTrpcClient>;
  let consulteeTrpc: ReturnType<typeof getTrpcClient>;

  beforeEach(async () => {
    ownerTrpc = getTrpcClient(await createTestUser());
    consulteeTrpc = getTrpcClient(await createTestUser());
  });

  it("发布→发现→咨询→降级标记→计量封顶 全链路", async () => {
    // D1 所有者发布领域专家（LLM 指向 aimock；单价=封顶值，为 D6 铺路）
    const profile = await ownerTrpc.agentProfiles.create.mutate({
      name: "Rust 专家",
      type: "openai-compatible",
      apiKey: "sk-test",
      baseUrl: "http://aimock:4010/v1",
      model: "gpt-5.6-luna",
    });
    const { publication } = await ownerTrpc.agentPublications.publish.mutate({
      agentProfileId: profile.id,
      title: "Rust 咨询",
      description: "Rust 所有权与异步编程",
      pricePerCall: 1000,
    });

    // D1 咨询者发现该发布
    const { publications } =
      await consulteeTrpc.agentPublications.discover.query();
    const card = publications.find((p) => p.id === publication.id);
    expect(card?.pricePerCall).toBe(1000);
    expect(card?.ownerName).toBeTruthy();

    // D2 咨询者发起会话（带 owner 维度）
    const session = await consulteeTrpc.chats.createSession.mutate({
      publicationId: publication.id,
    });
    expect(session.publicationId).toBe(publication.id);
    expect(session.ownerUserId).toBeTruthy();

    // 咨询问答（LLM 走 aimock；所有者知识库为空 → D5 降级标记）
    const result = await consulteeTrpc.chats.sendMessageSync.mutate({
      sessionId: session.id,
      content: "E2E consultation question about Rust ownership",
    });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("E2E consultation reply");
    expect(result.degradations).toContain("empty_knowledge");

    // D6 计量封顶：单价 1000 已记一笔 → 累计达 cap，下一条被拒
    await expect(
      consulteeTrpc.chats.sendMessageSync.mutate({
        sessionId: session.id,
        content: "another question",
      }),
    ).rejects.toThrow(/Session billing cap reached/);
  }, 120000);
});
