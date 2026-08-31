import { Bot, User, Wrench } from "lucide-react-native";
import { ActivityIndicator, Platform, PlatformColor, View } from "react-native";
import Markdown from "react-native-markdown-display";

import { Text } from "@/components/ui/Text";
import { cn } from "@/lib/utils";

import type { ChatMessageInfo } from "@/lib/useChatSync";

export default function ChatMessage({ message }: { message: ChatMessageInfo }) {
  const isUser = message.role === "user";

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
