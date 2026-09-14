"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { useTRPC, useTRPCClient } from "@saiye/shared-react/trpc";
import {
  WIDGET_API_VERSION,
  widgetPermissionTier,
} from "@saiye/shared/types/widgets";
import type {
  ZWidgetManifest,
  ZWidgetPermission,
} from "@saiye/shared/types/widgets";
import {
  zWidgetBookmarkCreateSchema,
  zWidgetBookmarkDeleteSchema,
  zWidgetBookmarkUpdateSchema,
  zWidgetListCreateSchema,
  zWidgetListDeleteSchema,
  zWidgetListMembershipSchema,
  zWidgetSetTagsSchema,
  zWidgetTagCreateSchema,
  zWidgetTagDeleteSchema,
} from "@saiye/shared/types/widgets";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { useTranslation } from "@/lib/i18n/client";
import { buildSandboxDoc } from "@/lib/widgets/runtime";
import { addWidgetActivity, summarizeWidgetWrite } from "@/lib/widgets/audit";
import { createWidgetRateLimiter } from "@/lib/widgets/rateLimit";
import WriteConfirmDialog from "@/components/dashboard/widgets/WriteConfirmDialog";
import type { WidgetConfirmTargetKind } from "@/components/dashboard/widgets/WriteConfirmDialog";

/**
 * 方法 → 所需权限（L0 读 / L1 写 / L2 删，见 docs/WIDGET_WRITE_API_DESIGN.md §3-4）。
 */
const METHOD_PERMISSIONS: Record<string, ZWidgetPermission> = {
  // L0 读（v0）
  "bookmarks.search": "bookmarks:read",
  "bookmarks.recent": "bookmarks:read",
  "bookmarks.get": "bookmarks:read",
  "tags.list": "tags:read",
  "lists.list": "lists:read",
  // L1 写（v1）
  "bookmarks.create": "bookmarks:write",
  "bookmarks.update": "bookmarks:write",
  "bookmarks.setTags": "bookmarks:write",
  "tags.create": "tags:write",
  "lists.create": "lists:write",
  "lists.addToList": "lists:write",
  "lists.removeFromList": "lists:write",
  // L2 删（v1）
  "bookmarks.delete": "bookmarks:delete",
  "tags.delete": "tags:delete",
  "lists.delete": "lists:delete",
};

/**
 * 桥侧输入窄化（D16）：payload 来自沙箱（不受信任），白名单外字段直接拒绝。
 */
function narrowPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: `invalid payload: ${
      issue ? `${issue.path.join(".") || "root"} ${issue.message}` : "校验失败"
    }`,
  };
}

/**
 * Widget 沙箱宿主：把 widget code 放入 <iframe sandbox="allow-scripts"> 执行，
 * 通过 postMessage 桥提供只读数据访问。
 *
 * 安全边界：
 * - sandbox 无 allow-same-origin → opaque origin，拿不到父页任何资源
 * - 包装文档 CSP default-src 'none' → 沙箱内无法发起任何网络请求
 * - 桥方法白名单 + manifest.permissions 权限校验 → 只允许声明的只读能力
 */
export default function WidgetHost({
  widgetId,
  manifest,
  mode,
  code: codeProp,
}: {
  /** 拥有者的组件 id；直接传 code（如发现页分享快照）时可省略 */
  widgetId?: string;
  manifest: ZWidgetManifest;
  /** preview=chat 预览卡（写被拦截）；installed=已启用组件（写放行，L2 逐次确认） */
  mode: "preview" | "installed";
  /** 直接传入 code 时跳过 widgets.get 查询（跨用户/匿名场景拿不到源组件） */
  code?: string;
}) {
  const api = useTRPC();
  // 原生 tRPC client：写路径用命令式 .mutate()（不进 React Query 缓存，见设计 §4.4）
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { theme } = useTheme();
  const resolvedTheme: "dark" | "light" = theme === "dark" ? "dark" : "light";
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  // L2 运行时确认（§6.2）：挂起的删除请求 + 待 resolve 的 Promise
  const confirmResolverRef = useRef<((allow: boolean) => void) | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{
    kind: WidgetConfirmTargetKind;
    targetId: string;
  } | null>(null);

  const requestConfirm = useCallback(
    (kind: WidgetConfirmTargetKind, targetId: string) =>
      new Promise<boolean>((resolve) => {
        confirmResolverRef.current = resolve;
        setPendingConfirm({ kind, targetId });
      }),
    [],
  );

  const resolveConfirm = useCallback((allow: boolean) => {
    confirmResolverRef.current?.(allow);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  }, []);

  // 桥侧限流（§8.2）：组件实例独立滑动窗口
  const rateLimiter = useMemo(() => createWidgetRateLimiter(), []);

  // 按需拉取 code（list 接口不返回 code，避免列表膨胀）；
  // 直接传入 code（分享快照预览）时跳过查询
  const { data: widget, isLoading } = useQuery(
    api.widgets.get.queryOptions(
      { widgetId: widgetId ?? "" },
      { enabled: codeProp === undefined && widgetId !== undefined },
    ),
  );

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (!data || data.saiye !== true) return;

      if (data.type === "resize") {
        const h = Math.max(80, Math.min(data.payload?.height ?? 120, 2000));
        setHeight(h);
        return;
      }

      // 组件崩溃上报：占位已在沙箱内渲染，宿主 console 留痕便于排查
      if (data.type === "error") {
        console.error(
          "[widget] runtime error:",
          data.payload?.message ?? "unknown",
        );
        return;
      }

      if (data.type !== "api") return;

      const method: string = data.method;
      const required = METHOD_PERMISSIONS[method] ?? null;
      const reply = (ok: boolean, body: Record<string, unknown>) => {
        iframe.contentWindow?.postMessage(
          { saiye: true, id: data.id, ok, ...body },
          "*",
        );
      };

      if (!required || !manifest.permissions.includes(required)) {
        reply(false, { error: `permission denied: ${required ?? "unknown"}` });
        return;
      }

      // 预览态写拦截（D13）：结构化拒绝而非 mock 成功，让组件可 catch
      // 并渲染"安装后可用"降级 UI；宿主同步 toast 提示用户
      if (mode === "preview" && widgetPermissionTier(required) !== "read") {
        reply(false, { error: `preview_write_blocked: ${method}` });
        toast.info(t("widgets.preview_write_blocked"));
        return;
      }

      // 桥侧限流（§8.2）：写 60/min、删 10/min，超出回 rate_limited（记审计）
      const tier = widgetPermissionTier(required);
      const widgetName = widget?.name ?? "";
      const audit = (outcome: "ok" | "error" | "denied", summary: string) => {
        if (tier === "read") return;
        addWidgetActivity({
          // 预览态写操作在上方已被拦截，这里仅 installed 模式（widgetId 必有）
          widgetId: widgetId ?? "",
          widgetName,
          action: method,
          outcome,
          summary,
        });
      };
      if (tier !== "read" && !rateLimiter.consume(tier)) {
        reply(false, { error: `rate_limited: ${method}` });
        audit("error", t("widgets.audit_rate_limited"));
        return;
      }

      // 窄化后的输入，审计摘要用
      let writeInput: Record<string, unknown> | undefined;

      try {
        let result: unknown;
        switch (method) {
          // —— L0 读（v0）——
          case "bookmarks.search":
            result = await queryClient.fetchQuery(
              api.bookmarks.searchBookmarks.queryOptions(
                (data.payload ?? {}) as never,
              ),
            );
            break;
          case "bookmarks.recent":
            result = await queryClient.fetchQuery(
              api.bookmarks.getBookmarks.queryOptions({
                sortOrder: "desc",
                ...((data.payload ?? {}) as Record<string, unknown>),
              }),
            );
            break;
          case "bookmarks.get":
            result = await queryClient.fetchQuery(
              api.bookmarks.getBookmark.queryOptions(
                (data.payload ?? {}) as never,
              ),
            );
            break;
          case "tags.list":
            result = await queryClient.fetchQuery(
              api.tags.list.queryOptions((data.payload ?? {}) as never),
            );
            break;
          case "lists.list":
            result = await queryClient.fetchQuery(
              api.lists.list.queryOptions(),
            );
            break;
          // —— L1/L2 写（v1）：先窄化校验（D16），再以用户身份执行 mutation ——
          // 与读路径同理，窄化后的 payload 静态类型用 as never 绕过，
          // 运行时由 tRPC zod input 二次校验。
          case "bookmarks.create": {
            const p = narrowPayload(zWidgetBookmarkCreateSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            result = await trpcClient.bookmarks.createBookmark.mutate(
              p.data as never,
            );
            break;
          }
          case "bookmarks.update": {
            const p = narrowPayload(zWidgetBookmarkUpdateSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            result = await trpcClient.bookmarks.updateBookmark.mutate(
              p.data as never,
            );
            break;
          }
          case "bookmarks.setTags": {
            const p = narrowPayload(zWidgetSetTagsSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            writeInput = p.data;
            result = await trpcClient.bookmarks.updateTags.mutate(
              p.data as never,
            );
            break;
          }
          case "bookmarks.delete": {
            const p = narrowPayload(zWidgetBookmarkDeleteSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            // L2 逐次确认（§6.2）：拒绝回 user_denied，允许才执行
            writeInput = p.data;
            if (!(await requestConfirm("bookmark", p.data.bookmarkId))) {
              reply(false, { error: `user_denied: ${method}` });
              audit(
                "denied",
                t("widgets.audit_user_denied", {
                  summary: summarizeWidgetWrite(method, writeInput, null),
                }),
              );
              return;
            }
            result = await trpcClient.bookmarks.deleteBookmark.mutate(
              p.data as never,
            );
            break;
          }
          case "tags.create": {
            const p = narrowPayload(zWidgetTagCreateSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            result = await trpcClient.tags.create.mutate(p.data as never);
            break;
          }
          case "tags.delete": {
            const p = narrowPayload(zWidgetTagDeleteSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            writeInput = p.data;
            if (!(await requestConfirm("tag", p.data.tagId))) {
              reply(false, { error: `user_denied: ${method}` });
              audit(
                "denied",
                t("widgets.audit_user_denied", {
                  summary: summarizeWidgetWrite(method, writeInput, null),
                }),
              );
              return;
            }
            result = await trpcClient.tags.delete.mutate(p.data as never);
            break;
          }
          case "lists.create": {
            const p = narrowPayload(zWidgetListCreateSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            result = await trpcClient.lists.create.mutate(p.data as never);
            break;
          }
          case "lists.addToList": {
            const p = narrowPayload(zWidgetListMembershipSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            result = await trpcClient.lists.addToList.mutate(p.data as never);
            break;
          }
          case "lists.removeFromList": {
            const p = narrowPayload(zWidgetListMembershipSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            result = await trpcClient.lists.removeFromList.mutate(
              p.data as never,
            );
            break;
          }
          case "lists.delete": {
            const p = narrowPayload(zWidgetListDeleteSchema, data.payload);
            if (!p.ok) {
              reply(false, { error: p.error });
              return;
            }
            writeInput = p.data;
            if (!(await requestConfirm("list", p.data.listId))) {
              reply(false, { error: `user_denied: ${method}` });
              audit(
                "denied",
                t("widgets.audit_user_denied", {
                  summary: summarizeWidgetWrite(method, writeInput, null),
                }),
              );
              return;
            }
            result = await trpcClient.lists.delete.mutate(p.data as never);
            break;
          }
          default:
            reply(false, { error: `unknown method: ${method}` });
            return;
        }
        reply(true, { data: result });
        audit(
          "ok",
          summarizeWidgetWrite(
            method,
            writeInput,
            result as Record<string, unknown>,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reply(false, { error: msg });
        audit("error", t("widgets.audit_failed", { message: msg }));
      }
    },
    [
      api,
      manifest.permissions,
      mode,
      queryClient,
      rateLimiter,
      requestConfirm,
      t,
      trpcClient,
      widget?.name,
      widgetId,
    ],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // API 版本守卫：未来宿主遇到高版本 manifest（apiVersion 契约）时给出明确提示，
  // 不渲染沙箱（避免用不兼容的 SDK 跑未知代码）
  if (manifest.apiVersion !== WIDGET_API_VERSION) {
    return (
      <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        {t("widgets.unsupported_api_version", {
          widgetVersion: String(manifest.apiVersion),
          hostVersion: WIDGET_API_VERSION,
        })}
      </div>
    );
  }

  const code = codeProp ?? widget?.code;
  if (codeProp === undefined ? isLoading || !widget : !code) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        {t("widgets.loading")}
      </div>
    );
  }

  return (
    <>
      <iframe
        ref={iframeRef}
        title="widget"
        sandbox="allow-scripts"
        srcDoc={buildSandboxDoc(code!, resolvedTheme)}
        style={{ height: `${height}px`, width: "100%", border: "none" }}
      />
      {pendingConfirm && (
        <WriteConfirmDialog
          open
          widgetName={widget?.name ?? ""}
          kind={pendingConfirm.kind}
          targetId={pendingConfirm.targetId}
          onResolve={resolveConfirm}
        />
      )}
    </>
  );
}
