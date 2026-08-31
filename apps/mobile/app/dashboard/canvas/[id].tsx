import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import FullPageSpinner from "@/components/ui/FullPageSpinner";
import useAppSettings from "@/lib/settings";

// WebView 查看画布：加载 Web 端独立路由 /canvas/{id}，
// 用本地保存的 apiKey 走查询参数鉴权（无需在 WebView 内登录）
export default function CanvasViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { settings } = useAppSettings();

  if (typeof id !== "string") {
    return null;
  }

  const base = settings.address.replace(/\/+$/, "");
  const uri = settings.apiKey
    ? `${base}/canvas/${id}?apiKey=${encodeURIComponent(settings.apiKey)}`
    : `${base}/canvas/${id}`;

  return (
    <View className="flex-1">
      <WebView
        source={{ uri }}
        startInLoadingState
        renderLoading={() => <FullPageSpinner />}
      />
    </View>
  );
}
