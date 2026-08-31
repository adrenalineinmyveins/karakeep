"use client";

/**
 * 根级 React 错误边界（Next.js App Router 约定文件）。
 * 捕获根 layout 及其子树渲染期抛出的异常——route 段内已有
 * dashboard/error.tsx 等分段边界兜底日常页面，这里只接管漏网的
 * 根层级崩溃，并把错误日志打到控制台便于排查（配合
 * GlobalErrorLogger 捕获非 React 渲染路径的异常）。
 * 注意：global-error 会替换整个 <html>，必须自带 html/body 标签。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  console.error("[GlobalError] render crashed", {
    time: new Date().toISOString(),
    message: error.message,
    digest: error.digest,
    stack: error.stack,
  });

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ textAlign: "center", padding: "2rem" }}>
            <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
              Something went wrong
            </h1>
            <p
              style={{
                color: "#666",
                marginBottom: "1.5rem",
                wordBreak: "break-all",
              }}
            >
              {error.message}
              {error.digest ? ` (digest: ${error.digest})` : ""}
            </p>
            <button
              onClick={reset}
              style={{
                padding: "0.5rem 1rem",
                cursor: "pointer",
                borderRadius: "0.375rem",
                border: "1px solid #ccc",
                background: "#fff",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
