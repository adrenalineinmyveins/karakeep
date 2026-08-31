import { useRouter } from "expo-router";
import { MessageCircle, Paintbrush, Plus, Trash2 } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import FullPageSpinner from "@/components/ui/FullPageSpinner";
import { Text } from "@/components/ui/Text";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { cn } from "@/lib/utils";

export default function ChatSessionList({
  currentSessionId,
}: {
  currentSessionId?: string;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: sessions, isLoading } = useQuery(
    api.chats.listSessions.queryOptions(),
  );

  const createSession = useMutation(
    api.chats.createSession.mutationOptions({
      onSuccess: (session) => {
        queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
        router.push(`/dashboard/chats/${session.id}`);
      },
    }),
  );

  const deleteSession = useMutation(
    api.chats.deleteSession.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
      },
    }),
  );

  if (isLoading) {
    return <FullPageSpinner />;
  }

  return (
    <View className="flex-1">
      <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
        <Text variant="heading">对话</Text>
        <View className="flex-row items-center gap-1">
          <Button
            variant="plain"
            size="icon"
            onPress={() => router.push("/dashboard/canvas")}
            accessibilityLabel="画布列表"
          >
            <Paintbrush size={20} color="#007AFF" />
          </Button>
          <Button
            variant="plain"
            size="icon"
            onPress={() => createSession.mutate({})}
            accessibilityLabel="新建对话"
          >
            <Plus size={20} color="#007AFF" />
          </Button>
        </View>
      </View>

      {sessions && sessions.length > 0 ? (
        <ScrollView>
          {sessions.map((session) => (
            <Pressable
              key={session.id}
              onPress={() =>
                router.push(`/dashboard/chats/${session.id}`)
              }
              className={cn(
                "flex-row items-center gap-2 px-4 py-3",
                session.id === currentSessionId && "bg-primary/10",
              )}
            >
              <MessageCircle size={16} color="#888" />
              <Text
                variant="body"
                className="flex-1"
                numberOfLines={1}
              >
                {session.title}
              </Text>
              <Pressable
                hitSlop={8}
                onPress={() => deleteSession.mutate({ sessionId: session.id })}
                accessibilityLabel="删除对话"
              >
                <Trash2 size={16} color="#FF3B30" />
              </Pressable>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-muted-foreground">
            还没有对话
          </Text>
          <Button
            variant="tonal"
            size="md"
            className="mt-4"
            onPress={() => createSession.mutate({})}
          >
            新建对话
          </Button>
        </View>
      )}
    </View>
  );
}
