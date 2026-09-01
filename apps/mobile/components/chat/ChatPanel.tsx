import { useEffect, useRef } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";

import ChatInput from "@/components/chat/ChatInput";
import ChatMessage from "@/components/chat/ChatMessage";
import { Text } from "@/components/ui/Text";
import { useChatSync } from "@/lib/useChatSync";

export default function ChatPanel({ sessionId }: { sessionId: string }) {
  const { messages, isSending, sendMessage, abort } = useChatSync(sessionId);
  const scrollRef = useRef<ScrollView>(null);

  // 新消息自动滚底
  useEffect(() => {
    if (messages.length === 0) return;
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 50);
  }, [messages]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}
    >
      <View className="flex-1">
        {messages.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-center text-muted-foreground">
              开始对话，我可以帮你搜索书签、整理标签、收藏链接
            </Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            className="flex-1"
            contentContainerClassName="gap-4 p-4"
          >
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
          </ScrollView>
        )}

        <ChatInput onSend={sendMessage} onAbort={abort} isSending={isSending} />
      </View>
    </KeyboardAvoidingView>
  );
}
