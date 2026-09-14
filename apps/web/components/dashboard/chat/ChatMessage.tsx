"use client";

import { Bot, User, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";

import { cn } from "@/lib/utils";

import WidgetPreviewCard from "@/components/dashboard/chat/WidgetPreviewCard";
import type { ChatMessageInfo } from "@/lib/hooks/useChat";

/** widget 类工具：结果用预览卡渲染而非普通 badge */
const WIDGET_TOOL_NAMES = new Set(["save_widget", "update_widget"]);

export default function ChatMessage({ message }: { message: ChatMessageInfo }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      {/* 头像 */}
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>

      {/* 消息体 */}
      <div className={cn("flex max-w-[80%] flex-col gap-1")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2 text-sm",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          {message.content ? (
            <ReactMarkdown>{message.content}</ReactMarkdown>
          ) : message.pending ? (
            <span className="flex items-center gap-1.5">
              <span>思考中</span>
              <span className="flex gap-0.5">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
              </span>
            </span>
          ) : (
            ""
          )}
          {message.pending && message.content && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-current align-text-bottom" />
          )}
        </div>

        {/* 工具调用 */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1">
            {message.toolCalls.map((tc, i) =>
              WIDGET_TOOL_NAMES.has(tc.toolName) ? (
                tc.status === "end" && tc.result !== undefined ? (
                  <WidgetPreviewCard key={i} result={tc.result} />
                ) : null
              ) : (
                <ToolCallBadge key={i} toolCall={tc} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallBadge({
  toolCall,
}: {
  toolCall: {
    toolName: string;
    status: "start" | "end";
    args?: unknown;
    result?: unknown;
  };
}) {
  const isRunning = toolCall.status === "start";
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground",
        isRunning ? "animate-pulse bg-muted/50" : "bg-muted/30",
      )}
    >
      <Wrench size={12} />
      <span>
        {isRunning ? "调用" : "完成"}：{toolCall.toolName}
      </span>
    </div>
  );
}
