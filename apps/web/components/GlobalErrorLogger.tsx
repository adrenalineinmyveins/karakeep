"use client";

import { useEffect } from "react";

/**
 * 全局未捕获异常日志器。
 *
 * 背景：画布（plait/drawnix）的崩溃大多发生在 DOM 事件回调、rAF 循环或
 * Promise 微任务里（如 "Cannot read properties of undefined (reading
 * 'viewBox')"），这类异常 React ErrorBoundary 抓不到，只有 window 级
 * 监听能看到。统一在这里打结构化日志，方便事后从控制台/日志收集排查。
 */
export default function GlobalErrorLogger() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      console.error("[GlobalError] uncaught error", {
        time: new Date().toISOString(),
        message: event.message,
        source: `${event.filename}:${event.lineno}:${event.colno}`,
        stack: event.error?.stack,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      console.error("[GlobalError] unhandled rejection", {
        time: new Date().toISOString(),
        message: String(event.reason?.message ?? event.reason),
        stack: event.reason?.stack,
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
