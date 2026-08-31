import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@karakeep/db";
import { chatMessages, chatSessions } from "@karakeep/db/schema";
import { InferenceClientFactory } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";

import { authedProcedure, router } from "../index";
import { AgentOrchestrator } from "../lib/agent/orchestrator";
import { buildAgentTools } from "../lib/agent/tools";

/**
 * 清理 LLM 生成的标题：
 * - 尝试解析 JSON（{title: "..."}）
 * - 去除首尾引号
 * - 截断到 50 字
 */
function sanitizeTitle(raw: string): string {
  let t = raw.trim();
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && typeof parsed.title === "string") {
      t = parsed.title;
    }
  } catch {
    // 非 JSON，忽略
  }
  t = t.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return t.slice(0, 50);
}

export const chatsAppRouter = router({
  // 创建会话
  createSession: authedProcedure
    .input(z.object({ title: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const [session] = await db
        .insert(chatSessions)
        .values({
          userId: ctx.user.id,
          title: input.title ?? "新对话",
        })
        .returning();
      return session;
    }),

  // 列出当前用户的会话
  listSessions: authedProcedure.query(async ({ ctx }) => {
    return await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.userId, ctx.user.id))
      .orderBy(desc(chatSessions.modifiedAt));
  }),

  // 获取会话详情（含历史消息）
  getSession: authedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userId, ctx.user.id),
          ),
        )
        .limit(1);

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }

      const messages = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.chatId, input.sessionId))
        .orderBy(chatMessages.createdAt);

      return { session, messages };
    }),

  // 删除会话（消息级联删除 + 中止内存中的 Agent）
  deleteSession: authedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .delete(chatMessages)
        .where(eq(chatMessages.chatId, input.sessionId));
      await db
        .delete(chatSessions)
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userId, ctx.user.id),
          ),
        );

      AgentOrchestrator.getInstance().abortSession(
        ctx.user.id,
        input.sessionId,
      );

      return { success: true };
    }),

  // 更新会话标题
  updateTitle: authedProcedure
    .input(z.object({ sessionId: z.string(), title: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [session] = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }

      await db
        .update(chatSessions)
        .set({ title: input.title, modifiedAt: new Date() })
        .where(eq(chatSessions.id, input.sessionId));
      return { success: true };
    }),

  // 用 LLM 根据全部对话内容生成会话标题，失败时回退为首条用户消息
  generateTitle: authedProcedure
    .input(z.object({ sessionId: z.string() }))
    .output(z.object({ title: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const ownershipFilter = and(
        eq(chatSessions.id, input.sessionId),
        eq(chatSessions.userId, ctx.user.id),
      );

      const [session] = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(ownershipFilter)
        .limit(1);
      if (!session) {
        return { title: undefined };
      }

      const rows = await db
        .select({ role: chatMessages.role, content: chatMessages.content })
        .from(chatMessages)
        .where(eq(chatMessages.chatId, input.sessionId))
        .orderBy(chatMessages.createdAt);

      const firstUser = rows.find((r) => r.role === "user");
      if (!firstUser) {
        return { title: undefined };
      }

      let title = "";
      const client = InferenceClientFactory.build();
      if (client) {
        try {
          const transcript = rows
            .map(
              (r) => `${r.role === "user" ? "用户" : "助手"}: ${r.content.slice(0, 500)}`,
            )
            .join("\n")
            .slice(0, 12000);

          const inf = await client.inferFromText(
            `请根据以下完整对话内容生成一个简短的标题，要求：不超过20个字；概括整个对话的核心主题；直接输出标题文字，不要引号、句号或任何解释。

对话内容：
${transcript}`,
            { schema: null },
          );
          title = sanitizeTitle(inf.response);
        } catch (e) {
          logger.warn(
            `[chat.generateTitle] LLM 生成标题失败，回退为首条用户消息: ${e}`,
          );
        }
      }
      if (!title) {
        title = firstUser.content.trim().slice(0, 20);
      }

      const [updated] = await db
        .update(chatSessions)
        .set({ title })
        .where(ownershipFilter)
        .returning({ title: chatSessions.title });
      return { title: updated?.title };
    }),

  // ★ 流式对话（web 端，tRPC subscription + async generator）
  sendMessage: authedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        content: z.string().min(1),
      }),
    )
    .subscription(async function* ({ ctx, input }) {
      console.log("[chat.sendMessage] STEP 1: enter subscription");

      // 1. 验证会话归属
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!session) {
        console.log("[chat.sendMessage] session not found");
        yield { type: "error" as const, message: "Session not found" };
        return;
      }
      console.log("[chat.sendMessage] STEP 2: session found");

      // 2. 存储用户消息。若上一条已是孤儿 user 消息（上次请求中断未产生
      //    assistant 回复），则原地覆盖，避免出现连续两条 user。
      const [lastMsg] = await db
        .select({ id: chatMessages.id, role: chatMessages.role })
        .from(chatMessages)
        .where(eq(chatMessages.chatId, input.sessionId))
        .orderBy(desc(chatMessages.createdAt))
        .limit(1);
      if (lastMsg?.role === "user") {
        console.log(
          `[chat.sendMessage] STEP 3: overwriting orphan user message ${lastMsg.id}`,
        );
        await db
          .update(chatMessages)
          .set({ content: input.content })
          .where(eq(chatMessages.id, lastMsg.id));
      } else {
        await db.insert(chatMessages).values({
          chatId: input.sessionId,
          role: "user",
          content: input.content,
        });
        console.log("[chat.sendMessage] STEP 3: user message stored");
      }

      // 3. 构建用户专属工具集
      const tools = await buildAgentTools(ctx);
      console.log(
        "[chat.sendMessage] STEP 4: tools built, count:",
        tools.length,
      );

      // 4. 流式输出 Agent 事件并累积 assistant 内容
      let assistantContent = "";
      try {
        console.log("[chat.sendMessage] STEP 5: calling streamConversation");
        for await (const event of AgentOrchestrator.getInstance().streamConversation(
          {
            userId: ctx.user.id,
            sessionId: input.sessionId,
            prompt: input.content,
            tools,
          },
        )) {
          console.log("[chat.sendMessage] yielding event:", event.type);
          yield event;
          if (event.type === "token_delta") {
            assistantContent += event.delta;
          }
        }

        // 5. 存储 assistant 消息 + 刷新会话排序时间
        if (assistantContent) {
          await db.insert(chatMessages).values({
            chatId: input.sessionId,
            role: "assistant",
            content: assistantContent,
          });
        }
        await db
          .update(chatSessions)
          .set({ modifiedAt: new Date() })
          .where(eq(chatSessions.id, input.sessionId));
      } finally {
        // 客户端断连时 tRPC 调用 iterator.return()，此处自动触发
        AgentOrchestrator.getInstance().abortSession(
          ctx.user.id,
          input.sessionId,
        );
      }
    }),

  // 中止正在执行的会话
  abortSession: authedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      AgentOrchestrator.getInstance().abortSession(
        ctx.user.id,
        input.sessionId,
      );
      return { success: true };
    }),

  // ★ 非流式对话（mobile 端，一次性返回全部内容 + 工具调用记录）
  sendMessageSync: authedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        content: z.string().min(1),
      }),
    )
    .mutation(async function ({ ctx, input }) {
      // 1. 验证会话归属
      const [session] = await db
        .select()
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, input.sessionId),
            eq(chatSessions.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }

      // 2. 孤儿 user 消息覆盖（同 sendMessage）
      const [lastMsg] = await db
        .select({ id: chatMessages.id, role: chatMessages.role })
        .from(chatMessages)
        .where(eq(chatMessages.chatId, input.sessionId))
        .orderBy(desc(chatMessages.createdAt))
        .limit(1);
      if (lastMsg?.role === "user") {
        await db
          .update(chatMessages)
          .set({ content: input.content })
          .where(eq(chatMessages.id, lastMsg.id));
      } else {
        await db.insert(chatMessages).values({
          chatId: input.sessionId,
          role: "user",
          content: input.content,
        });
      }

      // 3. 流式事件聚合为一次性结果
      const tools = await buildAgentTools(ctx);

      let content = "";
      const toolCalls: Array<{
        toolName: string;
        status: "start" | "end";
        args?: unknown;
        result?: unknown;
      }> = [];
      let error: string | null = null;

      try {
        for await (const event of AgentOrchestrator.getInstance().streamConversation(
          {
            userId: ctx.user.id,
            sessionId: input.sessionId,
            prompt: input.content,
            tools,
          },
        )) {
          switch (event.type) {
            case "token_delta":
              content += event.delta;
              break;
            case "tool_call":
              toolCalls.push({
                toolName: event.toolName,
                status: event.status,
                args: event.args,
                result: event.result,
              });
              break;
            case "message_complete":
              content = event.content;
              break;
            case "error":
              error = event.message;
              break;
          }
        }

        if (content) {
          await db.insert(chatMessages).values({
            chatId: input.sessionId,
            role: "assistant",
            content,
          });
        }
        await db
          .update(chatSessions)
          .set({ modifiedAt: new Date() })
          .where(eq(chatSessions.id, input.sessionId));
      } finally {
        AgentOrchestrator.getInstance().abortSession(
          ctx.user.id,
          input.sessionId,
        );
      }

      return { content, toolCalls, error };
    }),
});
