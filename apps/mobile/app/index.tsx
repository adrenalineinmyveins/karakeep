import { Redirect } from "expo-router";

import useAppSettings from "@/lib/settings";

export default function App() {
  const { isLoading, settings } = useAppSettings();

  // 等 SecureStore 读取完成再分流，避免已登录用户被误弹回登录页
  if (isLoading) {
    return null;
  }

  if (settings.apiKey) {
    return <Redirect href="dashboard" />;
  }
  return <Redirect href="signin" />;
}
