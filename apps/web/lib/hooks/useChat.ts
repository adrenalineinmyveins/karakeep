"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useTRPC } from "@saiye/shared-react/trpc";

// ── 类型定义 ──────────────────────────────────────────

export interface ToolCallInfo {
  toolName: string;
  status: "start" | "end";
  args?: unknown;
  result?: unknown;
}

export interface ChatMessageInfo {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallInfo[];
  pending?: boolean;
  /** 标记为失败的回复（用于下次输入时本地清理） */
  isError?: boolean;
}

/** 客户端流空闲超时：超过该时长未收到任何事件视为断流兜底（服务端单轮 LLM 超时为 60s，正常情况下会先发出 error 事件） */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

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
    (content: string) => {
      if (!sessionId || !content.trim()) return;

      // 立即追加用户消息到 UI
      const userMsg: ChatMessageInfo = {
        id: `user-${msgIdCounter.current++}`,
        role: "user",
        content,
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
      { sessionId: sessionId!, content: pendingInput ?? "" },
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
        // 从 metadata 恢复工具调用记录（widget 预览卡等）
        const toolCalls = (
          m.metadata as { toolCalls?: ChatMessageInfo["toolCalls"] } | null
        )?.toolCalls;
        return {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
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
