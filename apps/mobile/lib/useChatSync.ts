import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";

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

let msgIdSeq = 0;

// ── Hook ──────────────────────────────────────────────

export function useChatSync(sessionId: string | undefined) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [isSending, setIsSending] = useState(false);

  const sendMessageMutation = useMutation(
    api.chats.sendMessageSync.mutationOptions({}),
  );

  const abortMutation = useMutation(
    api.chats.abortSession.mutationOptions({
      onSuccess: () => {
        // no-op；本地状态已在 abort 调用中更新
      },
    }),
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!sessionId || !content.trim() || isSending) return;
      const trimmed = content.trim();

      const userMsg: ChatMessageInfo = {
        id: `user-${msgIdSeq++}`,
        role: "user",
        content: trimmed,
      };
      const assistantMsg: ChatMessageInfo = {
        id: `assistant-${msgIdSeq++}`,
        role: "assistant",
        content: "",
        toolCalls: [],
        pending: true,
      };

      setMessages((prev) => {
        // 上次失败留下的孤儿对话（旧 user + ❌ assistant）：
        // 本地移除，由后端 UPDATE 同步覆盖 DB。
        if (prev.length >= 2) {
          const last = prev[prev.length - 1];
          const beforeLast = prev[prev.length - 2];
          if (last?.isError && beforeLast?.role === "user") {
            return [...prev.slice(0, -2), userMsg, assistantMsg];
          }
        }
        return [...prev, userMsg, assistantMsg];
      });

      setIsSending(true);
      try {
        const result = (await sendMessageMutation.mutateAsync({
          sessionId,
          content: trimmed,
        } as never)) as {
          content: string;
          toolCalls: ToolCallInfo[];
          error: string | null;
        };

        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? {
                  ...m,
                  content: result.error ? `❌ ${result.error}` : result.content,
                  toolCalls: result.toolCalls,
                  pending: false,
                  isError: !!result.error,
                }
              : m,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === "assistant"
              ? {
                  ...m,
                  content: `❌ 请求失败：${msg}`,
                  pending: false,
                  isError: true,
                }
              : m,
          ),
        );
      } finally {
        setIsSending(false);
        // 刷新会话列表的 modifiedAt
        queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
      }
    },
    [sessionId, isSending, sendMessageMutation, queryClient, api],
  );

  const abort = useCallback(() => {
    if (!sessionId) return;
    // 非流式模式下无法真正中止已发出的 HTTP 请求，
    // 但可以本地标记为已取消，并通知后端清理 Agent state。
    setIsSending(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.pending
          ? { ...m, pending: false, content: m.content || "（已取消）" }
          : m,
      ),
    );
    abortMutation.mutate({ sessionId } as never);
  }, [sessionId, abortMutation]);

  // 历史消息：useQuery 在 sessionId 变化时自动获取
  const historyQuery = useQuery(
    api.chats.getSession.queryOptions(
      { sessionId: sessionId! },
      { enabled: !!sessionId },
    ),
  );

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const data = historyQuery.data as
      | {
          messages: {
            id: string;
            role: "user" | "assistant" | "toolResult";
            content: string;
          }[];
        }
      | undefined;
    if (!data) return;
    setMessages(
      data.messages.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    );
  }, [sessionId, historyQuery.data]);

  return {
    messages,
    isSending,
    sendMessage,
    abort,
  };
}
