import { getServerAuthSession } from "@/server/auth";
import { getRealtimeBroker, type RealtimeEvent } from "@saiye/shared-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** D5 实时推送 SSE 端点：向当前用户推送 A2A 咨询收发事件 */
export async function GET(req: Request) {
  const session = await getServerAuthSession();
  if (!session?.user.id) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = session.user.id;
  const broker = getRealtimeBroker();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: RealtimeEvent) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      const unsubscribe = broker.subscribe(userId, send);
      // 心跳保活：防止代理/负载均衡空闲断连
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
