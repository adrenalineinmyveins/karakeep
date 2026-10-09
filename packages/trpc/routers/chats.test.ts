import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { BookmarkTypes } from "@saiye/shared/types/bookmarks";

import {
  agentPublications,
  bookmarkTexts,
  bookmarks,
  consultationUsages,
  users,
} from "@saiye/db/schema";

import {
  DELISTING_GRACE_PERIOD_MS,
  SESSION_BILLING_CAP_CREDITS,
  getSessionChargedCredits,
  recordConsultationUsage,
} from "./agentPublications";
import { buildAttachmentBlock } from "./chats";
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

/** 用户 0 发布档案，返回 publication */
async function publishExpert(
  context: CustomTestContext,
  overrides?: { pricePerCall?: number; billingCapPerSession?: number | null },
) {
  const profile = await createProfile(context.apiCallers[0]);
  const { publication } = await context.apiCallers[0].agentPublications.publish(
    {
      agentProfileId: profile.id,
      title: "Rust 咨询",
      pricePerCall: 10,
      ...overrides,
    },
  );
  return publication;
}

describe("Consultation Sessions (D2)", () => {
  test<CustomTestContext>("咨询者基于发布创建会话，会话带 owner 维度且标题默认取发布名", async (context) => {
    const publication = await publishExpert(context);
    const [owner] = await context.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "test1@test.com"));
    const session = await context.apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    expect(session.publicationId).toBe(publication.id);
    expect(session.ownerUserId).toBe(owner.id);
    expect(session.agentProfileId).toBe(publication.agentProfileId);
    expect(session.title).toBe(publication.title);
    // 咨询会话出现在咨询者自己的会话列表里
    const sessions = await context.apiCallers[1].chats.listSessions();
    expect(sessions.some((s) => s.id === session.id)).toBe(true);
  });

  test<CustomTestContext>("delisting 状态不接新咨询", async (context) => {
    const publication = await publishExpert(context);
    await context.apiCallers[0].agentPublications.delist({
      id: publication.id,
    });
    await expect(
      context.apiCallers[1].chats.createSession({
        publicationId: publication.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test<CustomTestContext>("缓冲期到期（惰性结算为 delisted）后不接新咨询", async (context) => {
    const publication = await publishExpert(context);
    await context.apiCallers[0].agentPublications.delist({
      id: publication.id,
    });
    await context.db
      .update(agentPublications)
      .set({
        delistingAt: new Date(Date.now() - DELISTING_GRACE_PERIOD_MS - 1),
      })
      .where(eq(agentPublications.id, publication.id));
    await expect(
      context.apiCallers[1].chats.createSession({
        publicationId: publication.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test<CustomTestContext>("不能咨询自己的发布", async (context) => {
    const publication = await publishExpert(context);
    await expect(
      context.apiCallers[0].chats.createSession({
        publicationId: publication.id,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test<CustomTestContext>("publicationId 与 agentProfileId 互斥", async (context) => {
    const publication = await publishExpert(context);
    await expect(
      context.apiCallers[1].chats.createSession({
        publicationId: publication.id,
        agentProfileId: publication.agentProfileId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test<CustomTestContext>("咨询会话不允许换绑档案", async (context) => {
    const publication = await publishExpert(context);
    const session = await context.apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    await expect(
      context.apiCallers[1].chats.updateSessionAgent({
        sessionId: session.id,
        agentProfileId: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test<CustomTestContext>("发布彻底下架后咨询会话停止服务", async (context) => {
    const publication = await publishExpert(context);
    const session = await context.apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    await context.apiCallers[0].agentPublications.delist({
      id: publication.id,
    });
    await context.db
      .update(agentPublications)
      .set({
        delistingAt: new Date(Date.now() - DELISTING_GRACE_PERIOD_MS - 1),
      })
      .where(eq(agentPublications.id, publication.id));
    await expect(
      context.apiCallers[1].chats.sendMessageSync({
        sessionId: session.id,
        content: "hello",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test<CustomTestContext>("缓冲期内的 delisting 会话继续服务（不因下架请求立即中断）", async (context) => {
    const publication = await publishExpert(context);
    const session = await context.apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    await context.apiCallers[0].agentPublications.delist({
      id: publication.id,
    });
    // 未过期：不抛 CONFLICT（会继续走到 LLM 调用，测试环境无 LLM 时
    // 以非 CONFLICT 的错误结束即可证明通过了状态校验）
    const err = await context.apiCallers[1].chats
      .sendMessageSync({ sessionId: session.id, content: "hello" })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).not.toBe("CONFLICT");
  });
});

describe("咨询引用笔记（attached notes）", () => {
  test<CustomTestContext>("仅返回本人名下条目：跨用户/不存在的 id 被忽略，笔记与正文进入背景块", async (context) => {
    const [consultee] = await context.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "test2@test.com"));
    const [owner] = await context.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "test1@test.com"));

    // 咨询者的 text 书签（note + 正文）
    const [mine] = await context.db
      .insert(bookmarks)
      .values({
        userId: consultee.id,
        type: BookmarkTypes.TEXT,
        title: "我的借用检查笔记",
        note: "生命周期这块总是记混",
      })
      .returning();
    await context.db.insert(bookmarkTexts).values({
      id: mine.id,
      text: "borrow checker 要求所有权的转移是显式的。",
    });

    // 专家（他人）名下的书签：不应出现在咨询者的引用结果里
    const [others] = await context.db
      .insert(bookmarks)
      .values({
        userId: owner.id,
        type: BookmarkTypes.TEXT,
        title: "专家私有草稿",
      })
      .returning();

    const { block, attachments } = await buildAttachmentBlock(
      context.db,
      consultee.id,
      [mine.id, others.id, "nonexistent-id"],
    );

    expect(attachments).toEqual([{ id: mine.id, title: "我的借用检查笔记" }]);
    expect(block).toContain("<attached_notes>");
    expect(block).toContain("我的借用检查笔记");
    expect(block).toContain("生命周期这块总是记混");
    expect(block).toContain("borrow checker");
    expect(block).not.toContain("专家私有草稿");
  });

  test<CustomTestContext>("无可引用条目时返回空块与空列表", async (context) => {
    const [consultee] = await context.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "test2@test.com"));
    const { block, attachments } = await buildAttachmentBlock(
      context.db,
      consultee.id,
      ["nonexistent-id"],
    );
    expect(block).toBe("");
    expect(attachments).toEqual([]);
  });
});

describe("Consultation Billing (D6)", () => {
  test<CustomTestContext>("会话累计计费达封顶后停止服务", async (context) => {
    const publication = await publishExpert(context);
    const session = await context.apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    // 直接灌入一笔达封顶的账（绕过 LLM 依赖）
    await context.db.insert(consultationUsages).values({
      publicationId: publication.id,
      consulteeUserId: session.userId,
      sessionId: session.id,
      amount: SESSION_BILLING_CAP_CREDITS,
    });
    await expect(
      context.apiCallers[1].chats.sendMessageSync({
        sessionId: session.id,
        content: "hello",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Session billing cap reached",
    });
  });

  test<CustomTestContext>("记账按当时单价快照，调价不影响已记条目", async (context) => {
    const publication = await publishExpert(context);
    const session = await context.apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    // 按发布单价 10 记一笔
    await recordConsultationUsage(context.db, session);
    // 所有者调价为 20 后再记一笔
    await context.apiCallers[0].agentPublications.update({
      id: publication.id,
      pricePerCall: 20,
    });
    await recordConsultationUsage(context.db, session);
    expect(await getSessionChargedCredits(context.db, session.id)).toBe(30);
    const rows = await context.db
      .select({ amount: consultationUsages.amount })
      .from(consultationUsages)
      .where(eq(consultationUsages.sessionId, session.id));
    expect(rows.map((r) => r.amount)).toEqual([10, 20]);
  });

  test<CustomTestContext>("F2 per-publication 封顶：自定义值生效且可调回 null", async (context) => {
    // 自定义 cap=50（低于全局默认 1000，若未生效则灌 50 不会触发封顶）
    const publication = await publishExpert(context, {
      billingCapPerSession: 50,
    });
    expect(publication.billingCapPerSession).toBe(50);
    const session = await context.apiCallers[1].chats.createSession({
      publicationId: publication.id,
    });
    await context.db.insert(consultationUsages).values({
      publicationId: publication.id,
      consulteeUserId: session.userId,
      sessionId: session.id,
      amount: 50,
    });
    await expect(
      context.apiCallers[1].chats.sendMessageSync({
        sessionId: session.id,
        content: "hello",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Session billing cap reached",
    });
    // 所有者把封顶调回 null（跟随全局默认）后继续服务
    const { publication: updated } =
      await context.apiCallers[0].agentPublications.update({
        id: publication.id,
        billingCapPerSession: null,
      });
    expect(updated.billingCapPerSession).toBeNull();
    const err = await context.apiCallers[1].chats
      .sendMessageSync({ sessionId: session.id, content: "hello" })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).not.toBe("CONFLICT");
  });
});
