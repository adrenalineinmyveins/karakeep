"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useTRPC } from "@saiye/shared-react/trpc";
import { extractToolResultText } from "@/components/dashboard/chat/WidgetPreviewCard";
import {
  updateBookmarksLayout,
  updateGridColumns,
  updateImageFit,
  updateInterfaceLang,
  updateShowNotes,
  updateShowTags,
  updateShowTitle,
} from "@/lib/userLocalSettings/userLocalSettings";
import type { BookmarksLayoutTypes } from "@/lib/userLocalSettings/types";

// ── 类型定义 ──────────────────────────────────────────

export interface ToolCallInfo {
  toolName: string;
  status: "start" | "end";
  args?: unknown;
  result?: unknown;
}

/** 咨询会话中显式引用的笔记（@引用） */
export interface ChatAttachment {
  id: string;
  title: string;
}

export interface ChatMessageInfo {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallInfo[];
  attachments?: ChatAttachment[];
  pending?: boolean;
  /** 标记为失败的回复（用于下次输入时本地清理） */
  isError?: boolean;
}

/** 客户端流空闲超时：超过该时长未收到任何事件视为断流兜底（服务端单轮 LLM 超时为 60s，正常情况下会先发出 error 事件） */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

// ── Device local settings application (chat tool returns them but does not persist to DB, frontend writes cookie) ──────────────

const LOCAL_SETTINGS_APPLIERS: Record<
  string,
  (value: unknown) => Promise<void>
> = {
  lang: (v) => updateInterfaceLang(v as string),
  bookmarkGridLayout: (v) => updateBookmarksLayout(v as BookmarksLayoutTypes),
  gridColumns: (v) => updateGridColumns(v as number),
  showNotes: (v) => updateShowNotes(v as boolean),
  showTags: (v) => updateShowTags(v as boolean),
  showTitle: (v) => updateShowTitle(v as boolean),
  imageFit: (v) => updateImageFit(v as "cover" | "contain"),
};

/** Apply localSettings returned by the tool one by one to cookie (calls in sequence to avoid concurrent read-modify-write races) */
async function applyLocalSettings(localSettings: Record<string, unknown>) {
  for (const [key, value] of Object.entries(localSettings)) {
    const apply = LOCAL_SETTINGS_APPLIERS[key];
    if (apply && value !== undefined) {
      await apply(value);
    }
  }
}

// ── Hook ──────────────────────────────────────────────

export function useChat(
  sessionId: string | undefined,
  /** 流空闲超时（CLI 型 agent 执行时间长，由 ChatPanel 按档案超时放宽；默认 90s） */
  idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // 待发送内容，只有当用户点击发送后才设置并触发 subscription
  const [pendingInput, setPendingInput] = useState<string | null>(null);
  // 待发送的引用笔记（与 pendingInput 同生命周期）
  const [pendingAttachments, setPendingAttachments] = useState<
    ChatAttachment[] | null
  >(null);
  const msgIdCounter = useRef(0);

  const invalidateSessions = useCallback(() => {
    queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
  }, [queryClient, api]);

  // ── 断流兜底（传输层错误 / 长时间无事件） ────────

  const streamIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStreamTimer = useCallback(() => {
    if (streamIdleTimer.current) {
      clearTimeout(streamIdleTimer.current);
      streamIdleTimer.current = null;
    }
  }, []);

  // 统一兜底：重置流式状态，末条 pending assistant 标记为失败（下次发送时本地清理）
  const handleStreamFailure = useCallback(
    (message: string) => {
      clearStreamTimer();
      setIsStreaming(false);
      setPendingInput(null);
      setPendingAttachments(null);
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 && m.role === "assistant"
            ? { ...m, content: `❌ ${message}`, pending: false, isError: true }
            : m,
        ),
      );
    },
    [clearStreamTimer],
  );

  const armStreamTimer = useCallback(() => {
    clearStreamTimer();
    streamIdleTimer.current = setTimeout(() => {
      handleStreamFailure("连接超时：长时间未收到响应，请重试");
    }, idleTimeoutMs);
  }, [clearStreamTimer, handleStreamFailure, idleTimeoutMs]);
  useEffect(() => clearStreamTimer, [clearStreamTimer]);

  // ── 发送消息 ──────────────────────────────────────

  const sendMessage = useCallback(
    (content: string, attached?: ChatAttachment[]) => {
      if (!sessionId || !content.trim()) return;

      // 立即追加用户消息到 UI
      const userMsg: ChatMessageInfo = {
        id: `user-${msgIdCounter.current++}`,
        role: "user",
        content,
        ...(attached && attached.length > 0 ? { attachments: attached } : {}),
      };
      // 预占 assistant 消息位
      const assistantMsg: ChatMessageInfo = {
        id: `assistant-${msgIdCounter.current++}`,
        role: "assistant",
        content: "",
        toolCalls: [],
        pending: true,
      };
      setMessages((prev) => {
        // 上次失败留下的孤儿对话（旧 user + ❌ assistant）：
        // 本地移除，由后端 UPDATE 同步覆盖 DB。避免 UI 出现连续 user。
        if (prev.length >= 2) {
          const last = prev[prev.length - 1];
          const beforeLast = prev[prev.length - 2];
          if (last?.isError && beforeLast?.role === "user") {
            return [...prev.slice(0, -2), userMsg, assistantMsg];
          }
        }
        return [...prev, userMsg, assistantMsg];
      });
      setIsStreaming(true);
      setPendingInput(content);
      setPendingAttachments(attached && attached.length > 0 ? attached : null);
      armStreamTimer();
    },
    [sessionId, armStreamTimer],
  );

  // ── 中止对话 ──────────────────────────────────────

  const abortMutation = useMutation(
    api.chats.abortSession.mutationOptions({
      onSuccess: () => {
        setIsStreaming(false);
        setPendingInput(null);
        setPendingAttachments(null);
      },
    }),
  );

  const abort = useCallback(() => {
    if (!sessionId) return;
    clearStreamTimer();
    abortMutation.mutate({ sessionId });
    // 立即更新 UI，不等网络返回
    setIsStreaming(false);
    setPendingInput(null);
    setPendingAttachments(null);
    setMessages((prev) =>
      prev.map((m) =>
        m.pending
          ? { ...m, pending: false, content: m.content || "（已中断）" }
          : m,
      ),
    );
  }, [sessionId, abortMutation, clearStreamTimer]);

  // ── 流式订阅 ──────────────────────────────────────

  useSubscription(
    api.chats.sendMessage.subscriptionOptions(
      {
        sessionId: sessionId!,
        content: pendingInput ?? "",
        ...(pendingAttachments
          ? {
              attachedBookmarkIds: pendingAttachments.map((a) => a.id),
            }
          : {}),
      },
      {
        enabled: !!sessionId && !!pendingInput,
        onData(event) {
          // 每收到一个事件就重置空闲计时
          armStreamTimer();
          switch (event.type) {
            case "token_delta":
              setMessages((prev) =>
                prev.map((m, i) =>
                  i === prev.length - 1 && m.role === "assistant"
                    ? { ...m, content: m.content + event.delta }
                    : m,
                ),
              );
              break;

            case "tool_call":
              setMessages((prev) =>
                prev.map((m, i) => {
                  if (i !== prev.length - 1 || m.role !== "assistant") return m;
                  const toolCalls = [
                    ...(m.toolCalls ?? []),
                    {
                      toolName: event.toolName,
                      status: event.status,
                      args: event.args,
                      result: event.result,
                    },
                  ];
                  return { ...m, toolCalls };
                }),
              );
              if (event.status === "end") {
                // chat 改了用户设置 → 失效设置缓存，设置页与全局 context 实时拿到新值
                if (event.toolName === "update_user_settings") {
                  queryClient.invalidateQueries(
                    api.users.settings.pathFilter(),
                  );
                  // 设备本地设置（语言/布局/列数/显示开关）不落库：
                  // 从工具结果取出后写 cookie，让界面即时生效
                  // 注意 result 是 PI 原生 {content:[{type:"text",text}]} 结构，不能直接 JSON.parse
                  const text = extractToolResultText(event.result);
                  if (text) {
                    try {
                      const { localSettings } = JSON.parse(text) as {
                        localSettings?: Record<string, unknown>;
                      };
                      if (localSettings) {
                        void applyLocalSettings(localSettings);
                      }
                    } catch {
                      // 结果解析失败时忽略，不影响主流程
                    }
                  }
                }
                // RSS 订阅变更 → 失效订阅列表缓存，设置页订阅列表实时更新
                if (
                  event.toolName === "subscribe_feed" ||
                  event.toolName === "unsubscribe_feed"
                ) {
                  queryClient.invalidateQueries(api.feeds.list.pathFilter());
                }
              }
              break;

            case "message_complete":
              setMessages((prev) =>
                prev.map((m, i) =>
                  i === prev.length - 1 && m.role === "assistant"
                    ? { ...m, content: event.content, pending: false }
                    : m,
                ),
              );
              break;

            case "agent_end":
              clearStreamTimer();
              setIsStreaming(false);
              setPendingInput(null);
              setPendingAttachments(null);
              setMessages((prev) =>
                prev.map((m) => (m.pending ? { ...m, pending: false } : m)),
              );
              invalidateSessions();
              break;

            case "error":
              handleStreamFailure(event.message);
              break;
          }
        },
        // 传输层错误兜底（连接中断 / 401 / 服务器错误），避免 isStreaming 永久卡死
        onError() {
          handleStreamFailure("连接中断，请检查网络后重试");
        },
      },
    ),
  );

  // ── 加载历史消息 ──────────────────────────────────

  const loadHistory = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const data = await queryClient.fetchQuery(
      api.chats.getSession.queryOptions({ sessionId }),
    );
    setMessages(
      data.messages.map((m) => {
        // 从 metadata 恢复工具调用记录（widget 预览卡等）与引用笔记
        const toolCalls = (
          m.metadata as { toolCalls?: ChatMessageInfo["toolCalls"] } | null
        )?.toolCalls;
        const attachments = (
          m.metadata as { attachments?: ChatAttachment[] } | null
        )?.attachments;
        return {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        };
      }),
    );
  }, [sessionId, queryClient, api]);

  return {
    messages,
    isStreaming,
    sendMessage,
    abort,
    loadHistory,
  };
}
