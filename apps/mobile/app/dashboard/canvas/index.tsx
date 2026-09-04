import { useRouter } from "expo-router";
import { Paintbrush } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import FullPageSpinner from "@/components/ui/FullPageSpinner";
import { Text } from "@/components/ui/Text";
import { useTRPC } from "@saiye/shared-react/trpc";

export default function CanvasListScreen() {
  const api = useTRPC();
  const router = useRouter();

  const { data: canvases, isLoading } = useQuery(
    api.canvases.listCanvases.queryOptions(),
  );

  if (isLoading) {
    return <FullPageSpinner />;
  }

  return (
    <View className="flex-1">
      {canvases && canvases.length > 0 ? (
        <ScrollView>
          {canvases.map((canvas) => (
            <Pressable
              key={canvas.id}
              onPress={() => router.push(`/dashboard/canvas/${canvas.id}`)}
              className="flex-row items-center gap-2 px-4 py-3"
            >
              <Paintbrush size={16} color="#888" />
              <Text variant="body" className="flex-1" numberOfLines={1}>
                {canvas.title}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-muted-foreground">
            还没有画布。可以在 AI 对话中让助手创建，或在网页端新建。
          </Text>
        </View>
      )}
    </View>
  );
}
