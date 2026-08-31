import { useLocalSearchParams } from "expo-router";
import { Platform } from "react-native";
import { Stack } from "expo-router/stack";
import ChatPanel from "@/components/chat/ChatPanel";

export default function ChatDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <>
      <Stack.Screen
        options={{
          title: "对话",
          headerBackTitle: "Back",
          headerLargeTitle: false,
          headerTransparent: Platform.select({
            ios: false,
            default: undefined,
          }),
        }}
      />
      <ChatPanel sessionId={id} />
    </>
  );
}
