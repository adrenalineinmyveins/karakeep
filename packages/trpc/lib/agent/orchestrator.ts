/**
 * Agent 编排器
 *
 * 职责：会话生命周期管理、内存缓存、请求串行化、中断处理。
 * - 单例（进程级）
 * - 同一会话的请求通过 tail Promise 链强制串行
 * - 空闲 30 分钟的会话缓存自动过期
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@karakeep/db";
import { chatMessages, chatSessions } from "@karakeep/db/schema";

import type { AgentEvent, AgentInterface, ToolDefinition } from "./sdkAdapter";
import { createAgent } from "./sdkAdapter";

interface SessionHandle {
  agent: AgentInterface;
  userId: string;
  sessionId: string;
  toolSetHash: string;
  tail: Promise<void>;
  lastUsed: number;
}

const MAX_IDLE_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const SYSTEM_PROMPT = `你是 Karakeep 的 AI 助手，帮助用户管理他们的书签知识库。

你的能力：
1. 搜索与检索：用户问"我保存过关于 X 的文章吗？"时，使用 search_bookmarks 工具搜索
2. 知识问答：基于搜索到的书签内容回答问题，引用来源
3. 自动整理：批量打标签、归类到清单
4. 智能抓取：用户说"帮我保存这个链接"时，使用 create_bookmark
5. 网络搜索：当问题涉及用户书签库中没有的内容（如时事、最新资讯、外部产品信息）时，使用 web_search 工具搜索互联网
6. 画布生成：用户想把某个流程、架构、思路可视化成图时，先把内容转成合法的 mermaid 语法（graph TD / flowchart / mindmap 等），再调用 create_canvas 工具（mermaid 参数必填），工具会把 mermaid 转换为 drawnix 无限画布元素并保存，返回编辑链接

行为规范：
- 回答问题前，先用 search_bookmarks 检索相关书签
- 如果搜索结果不足以回答，且问题涉及外部信息（非用户的个人收藏），再用 web_search 搜索互联网
- 如果搜索结果不足以回答，明确告知用户
- 使用 list_tags 和 list_lists 了解用户现有的分类体系，尽量复用
- 整理操作前说明计划，获得用户确认后批量执行
- 使用中文回复`;

export class AgentOrchestrator {
  private static instance: AgentOrchestrator;
  private sessions = new Map<string, SessionHandle>();
  private lastCleanupTime = 0;

  static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator();
    }
    return AgentOrchestrator.instance;
  }

  /**
   * 核心执行方法 —— 返回 AsyncGenerator<AgentEvent>
   * 被 tRPC subscription（流式）和 mutation（聚合）消费。
   */
  async *streamConversation(params: {
    userId: string;
    sessionId: string;
    prompt: string;
    tools: ToolDefinition[];
  }): AsyncGenerator<AgentEvent> {
    let handle: SessionHandle;
    console.log(
      "[Orchestrator] streamConversation START, prompt:",
      params.prompt.slice(0, 30),
    );
    try {
      handle = await this.getOrCreateSession(params);
      console.log("[Orchestrator] getOrCreateSession OK, model resolved");
    } catch (e) {
      console.error(
        "[Orchestrator] getOrCreateSession FAILED:",
        e instanceof Error ? e.message : e,
      );
      yield {
        type: "error",
        message: `Failed to create agent: ${e instanceof Error ? e.message : String(e)}`,
      };
      return;
    }

    // ★ 串行化：同一会话的上一次请求完成前排队
    await handle.tail;

    // 事件队列 + Promise 桥接
    const queue: AgentEvent[] = [];
    let resolver: (() => void) | null = null;
    const notify = () => {
      resolver?.();
    };

    const unsubscribe = handle.agent.subscribe((evt) => {
      queue.push(evt);
      notify();
    });

    // 触发 Agent 执行（不 await，事件经 subscribe 流入队列）
    handle.tail = handle.agent.prompt(params.prompt).then(
      () => {
        console.log("[Orchestrator] agent.prompt() resolved successfully");
        queue.push({ type: "agent_end" });
        notify();
      },
      (err: Error) => {
        console.error(
          "[Orchestrator] agent.prompt() REJECTED:",
          err.message,
          err.stack,
        );
        queue.push({ type: "error", message: err.message });
        notify();
      },
    );

    let errored = false;
    try {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolver = r;
          });
        }
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (event.type === "error") {
            errored = true;
            return;
          }
          if (event.type === "agent_end") {
            return;
          }
        }
      }
    } finally {
      unsubscribe();
      handle.lastUsed = Date.now();
      // 出错时废弃缓存，下次请求从 DB 重新加载干净的历史
      if (errored) {
        const key = `${handle.userId}:${handle.sessionId}`;
        if (this.sessions.delete(key)) {
          console.log(
            `[Orchestrator] error detected, invalidated cached session ${key} (下次请求会重新从 DB 加载)`,
          );
        }
      }
    }
  }

  /** 中止正在执行的会话 */
  abortSession(userId: string, sessionId: string) {
    const key = `${userId}:${sessionId}`;
    const handle = this.sessions.get(key);
    if (handle) {
      handle.agent.abort();
    }
  }

  /** 清理过期会话缓存 */
  cleanupExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [key, handle] of this.sessions) {
      if (now - handle.lastUsed > MAX_IDLE_MS) {
        const idleMin = Math.round((now - handle.lastUsed) / 60000);
        console.log(
          `[Orchestrator] cleanupExpired: removing session ${key} (idle ${idleMin}min)`,
        );
        this.sessions.delete(key);
        removed++;
      }
    }
    console.log(
      `[Orchestrator] cleanupExpired: ${removed}/${this.sessions.size + removed} sessions removed, ${this.sessions.size} remaining`,
    );
  }

  // ── 内部方法 ─────────────────────────────────────────

  private async getOrCreateSession(params: {
    userId: string;
    sessionId: string;
    tools: ToolDefinition[];
  }): Promise<SessionHandle> {
    // 顺带做周期性过期清理
    const now = Date.now();
    if (now - this.lastCleanupTime > CLEANUP_INTERVAL_MS) {
      console.log(
        `[Orchestrator] getOrCreateSession: triggering cleanup (last cleanup ${Math.round((now - this.lastCleanupTime) / 60000)}min ago)`,
      );
      this.cleanupExpired();
      this.lastCleanupTime = now;
    }

    const key = `${params.userId}:${params.sessionId}`;
    const toolSetHash = params.tools.map((t) => t.name).join(",");

    const existing = this.sessions.get(key);
    if (existing && existing.toolSetHash === toolSetHash) {
      console.log(
        `[Orchestrator] getOrCreateSession: cache HIT for ${key} (tools: ${toolSetHash})`,
      );
      existing.lastUsed = Date.now();
      return existing;
    }
    console.log(
      existing
        ? `[Orchestrator] getOrCreateSession: cache MISS for ${key} (toolSet changed: "${existing.toolSetHash}" -> "${toolSetHash}")`
        : `[Orchestrator] getOrCreateSession: cache MISS for ${key} (new session)`,
    );

    // ★ 从 DB 恢复历史消息
    const history = await this.restoreHistory(
      params.sessionId,
      params.userId,
    );

    const handle: SessionHandle = {
      agent: createAgent({
        systemPrompt: SYSTEM_PROMPT,
        tools: params.tools,
        history,
      }),
      userId: params.userId,
      sessionId: params.sessionId,
      toolSetHash,
      tail: Promise.resolve(),
      lastUsed: Date.now(),
    };

    this.sessions.set(key, handle);
    return handle;
  }

  /**
   * 从 DB 恢复历史消息：
   * - 只取 user/assistant（toolResult 不传给 LLM）
   * - 取最近 20 条（倒序查询后反转回时间正序）
   * - 连续同 role 消息合并（中断重试可能留下连续 user）
   * - 开头的孤儿 assistant 消息丢弃
   */
  private async restoreHistory(
    sessionId: string,
    userId: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    // 先验证会话归属（chatMessages 表无 userId 列，经 chatSessions 关联）
    const [session] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.userId, userId),
        ),
      )
      .limit(1);
    if (!session) {
      console.log(
        `[Orchestrator] restoreHistory: session ${sessionId} not found for user ${userId}`,
      );
      return [];
    }

    const rows = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatId, sessionId),
          inArray(chatMessages.role, ["user", "assistant"]),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(20);
    console.log(
      `[Orchestrator] restoreHistory: queried ${rows.length} messages for session ${sessionId} (limit 20)`,
    );

    // 倒序取回后恢复时间正序
    const chronological = rows.reverse().map((r) => ({
      role: r.role as "user" | "assistant",
      content: r.content,
    }));

    // 连续同 role 合并
    const merged: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of chronological) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) {
        last.content += `\n\n${m.content}`;
      } else {
        merged.push({ ...m });
      }
    }

    // 开头的孤儿 assistant 丢弃
    const result =
      merged[0]?.role === "assistant" ? merged.slice(1) : merged;

    if (result.length !== chronological.length) {
      console.log(
        `[Orchestrator] restoreHistory: merged ${chronological.length} -> ${result.length} messages (连续同 role 合并)`,
      );
    }
    return result;
  }
}
