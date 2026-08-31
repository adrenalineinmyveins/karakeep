import { useRouter } from "expo-router";
import { Bot, Paintbrush, User, Wrench } from "lucide-react-native";
import { ActivityIndicator, Platform, PlatformColor, Pressable, View } from "react-native";
import Markdown from "react-native-markdown-display";

import { Text } from "@/components/ui/Text";
import { cn } from "@/lib/utils";

import type { ChatMessageInfo } from "@/lib/useChatSync";

// 从消息中提取画布引用：
// ① 实时回复的 toolCalls（create_canvas 工具结果 JSON，含标题）
// ② 消息文本中的 /dashboard/canvas/{id} 链接（覆盖历史 toolResult 行的
//   JSON 内容和模型回复里的 markdown 链接）
function extractCanvasRefs(
  message: ChatMessageInfo,
): Array<{ id: string; title?: string }> {
  const refs: Array<{ id: string; title?: string }> = [];
  const seen = new Set<string>();
  const add = (id: string, title?: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      refs.push({ id, title });
    }
  };

  for (const tc of message.toolCalls ?? []) {
    if (tc.toolName === "create_canvas" && tc.status === "end") {
      try {
        const raw =
          typeof tc.result === "string" ? JSON.parse(tc.result) : tc.result;
        if (raw && typeof raw.id === "string" && raw.editUrl) {
          add(raw.id, typeof raw.title === "string" ? raw.title : undefined);
        }
      } catch {
        // 非 JSON 结果，忽略
      }
    }
  }

  const linkRe = /\/dashboard\/canvas\/([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(message.content))) {
    add(m[1]);
  }
  return refs;
}

export default function ChatMessage({ message }: { message: ChatMessageInfo }) {
  const isUser = message.role === "user";
  const router = useRouter();
  const canvasRefs = extractCanvasRefs(message);

  return (
    <View className={cn("flex-row gap-3", isUser && "flex-row-reverse")}>
      {/* 头像 */}
      <View
        className={cn(
          "h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary" : "bg-muted",
        )}
      >
        {isUser ? (
          <User size={16} color={Platform.OS === "ios" ? PlatformColor("systemBackground") : "white"} />
        ) : (
          <Bot size={16} color={Platform.OS === "ios" ? PlatformColor("label") : "#666"} />
        )}
      </View>

      {/* 消息体 */}
      <View className="max-w-[80%] gap-1">
        <View
          className={cn(
            "rounded-2xl px-4 py-2",
            isUser ? "bg-primary" : "bg-muted",
          )}
        >
          {message.content ? (
            isUser ? (
              <Text
                className={cn(
                  Platform.OS === "ios" ? "text-white" : "text-white",
                )}
                variant="subhead"
              >
                {message.content}
              </Text>
            ) : (
              <Markdown>{message.content}</Markdown>
            )
          ) : message.pending ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator size="small" />
              <Text className="text-muted-foreground">思考中...</Text>
            </View>
          ) : null}
        </View>

        {/* 工具调用 */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <View className="gap-1">
            {message.toolCalls.map((tc, i) => (
              <ToolCallBadge key={i} toolCall={tc} />
            ))}
          </View>
        )}

        {/* 画布入口卡片：点击用 WebView 打开 Web 画布页 */}
        {canvasRefs.map((ref) => (
          <Pressable
            key={ref.id}
            onPress={() => router.push(`/dashboard/canvas/${ref.id}`)}
            className="flex-row items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2"
          >
            <Paintbrush size={14} color="#007AFF" />
            <Text variant="footnote" className="flex-1" numberOfLines={1}>
              {ref.title ?? "画布"}
            </Text>
            <Text variant="caption1" className="text-muted-foreground">
              查看
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
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
    <View
      className={cn(
        "flex-row items-center gap-1.5 rounded-lg px-2 py-1",
        isRunning ? "bg-muted/50" : "bg-muted/30",
      )}
    >
      {isRunning ? (
        <ActivityIndicator size={12} />
      ) : (
        <Wrench size={12} color="#888" />
      )}
      <Text variant="caption1" className="text-muted-foreground">
        {isRunning ? "调用" : "完成"}：{toolCall.toolName}
      </Text>
    </View>
  );
}
