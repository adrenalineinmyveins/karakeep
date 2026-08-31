import { notFound } from "next/navigation";

import CanvasEditor from "@/components/dashboard/canvas/CanvasEditor";
import {
  api,
  createContextFromApiKey,
  createTrcpClientFromCtx,
} from "@/server/api/client";

// 独立画布路由（不在 /dashboard 布局下，无 cookie session 守卫）：
// 供移动端 WebView 通过 ?apiKey= 查询参数访问；无 apiKey 时回退 cookie 会话。
export default async function StandaloneCanvasPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ apiKey?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const apiKey = Array.isArray(sp.apiKey) ? sp.apiKey[0] : sp.apiKey;

  let canvas;
  try {
    if (apiKey) {
      const ctx = await createContextFromApiKey(apiKey);
      canvas = await createTrcpClientFromCtx(ctx).canvases.getCanvas({
        canvasId: id,
      });
    } else {
      canvas = await api.canvases.getCanvas({ canvasId: id });
    }
  } catch {
    notFound();
  }

  return <CanvasEditor canvas={canvas} embedded />;
}
