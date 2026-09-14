"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useTRPC } from "@saiye/shared-react/trpc";
import { widgetPermissionTier } from "@saiye/shared/types/widgets";
import type { ZWidgetManifest } from "@saiye/shared/types/widgets";

import { cn } from "@/lib/utils";
import { addWidgetActivity } from "@/lib/widgets/audit";
import InstallConsentDialog from "@/components/dashboard/widgets/InstallConsentDialog";
import WidgetHost from "@/components/dashboard/widgets/WidgetHost";

/**
 * chat 内的 widget 预览卡：识别 save_widget / update_widget 的工具结果，
 * 拉取组件最新版本做 live 沙箱预览，并提供安装/重新安装入口。
 *
 * 按 D5：code 不入消息，渲染时经 widgets.get 拉最新版（迭代后旧消息显示最新态）。
 */

/** 从工具结果中提取文本：兼容字符串与 PI 原生 {content:[{type:"text",text}]} 两种形态 */
function extractToolResultText(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === "string") return result;
  if (typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const textPart = content.find(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: string }).type === "text",
      );
      const text = (textPart as { text?: unknown } | undefined)?.text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

interface WidgetToolResult {
  widgetId?: string;
  version?: number;
  reInstallRequired?: boolean;
}

export default function WidgetPreviewCard({ result }: { result: unknown }) {
  const text = extractToolResultText(result);
  let parsed: WidgetToolResult | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as WidgetToolResult;
    } catch {
      parsed = null;
    }
  }
  if (!parsed?.widgetId) return null;

  return (
    <WidgetPreviewCardInner
      widgetId={parsed.widgetId}
      generatedVersion={parsed.version}
      reInstallRequired={parsed.reInstallRequired}
    />
  );
}

function WidgetPreviewCardInner({
  widgetId,
  generatedVersion,
  reInstallRequired,
}: {
  widgetId: string;
  generatedVersion?: number;
  reInstallRequired?: boolean;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [consentOpen, setConsentOpen] = useState(false);

  const { data: widget, error } = useQuery({
    ...api.widgets.get.queryOptions({ widgetId }),
    retry: false,
    // D5：预览卡需展示最新版本（迭代/回滚后旧消息也显示最新态），挂载必刷
    refetchOnMount: "always",
  });

  const setStatus = useMutation(
    api.widgets.setStatus.mutationOptions({
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries(api.widgets.list.pathFilter());
        queryClient.invalidateQueries(api.widgets.get.pathFilter());
        // 从预览卡安装也记生命周期审计（§7.2，与 WidgetGrid 一致）
        if (variables.status === "enabled") {
          const perms =
            ((widget?.manifest ?? {}) as ZWidgetManifest).permissions ?? [];
          addWidgetActivity({
            widgetId,
            widgetName: widget?.name ?? "",
            action: "widget.install",
            outcome: "ok",
            summary: `安装组件（权限：${perms.join(", ") || "无"}）`,
          });
        }
      },
    }),
  );

  if (error) {
    return (
      <div className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        组件已被删除，无法预览
      </div>
    );
  }
  if (!widget) {
    return <div className="h-24 animate-pulse rounded-lg bg-muted/40" />;
  }

  const manifest = (widget.manifest ?? {}) as ZWidgetManifest;
  const enabled = widget.status === "enabled";
  // 含 L1/L2 权限的安装必须经过分级同意对话框（§6.1）；L0-only 保持 v0 直接安装
  const needsConsent = manifest.permissions.some(
    (p) => widgetPermissionTier(p) !== "read",
  );
  const install = () => {
    if (needsConsent) {
      setConsentOpen(true);
    } else {
      setStatus.mutate({ widgetId, status: "enabled" });
    }
  };

  return (
    <div className="w-full overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm">
      {/* 头部：名称/版本/状态 + 安装按钮 */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium">{widget.name}</span>
          <span className="text-[10px] text-muted-foreground">
            v{widget.currentVersion}
            {generatedVersion !== undefined &&
            generatedVersion !== widget.currentVersion
              ? `（生成于 v${generatedVersion}）`
              : ""}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px]",
              enabled
                ? "bg-green-500/15 text-green-600"
                : "bg-muted text-muted-foreground",
            )}
          >
            {enabled ? "已安装" : "草稿"}
          </span>
        </div>
        <button
          type="button"
          onClick={install}
          disabled={setStatus.isPending || enabled}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium",
            enabled
              ? "cursor-default bg-green-500/15 text-green-600"
              : "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50",
          )}
        >
          {enabled ? (
            <Check size={12} />
          ) : reInstallRequired ? (
            <RefreshCw size={12} />
          ) : (
            <Download size={12} />
          )}
          {enabled ? "已安装" : reInstallRequired ? "重新安装" : "安装"}
        </button>
      </div>

      {/* 沙箱实时预览（读走真实数据 D3；写在预览态被桥拦截，见设计 §5） */}
      <div className="p-2">
        <WidgetHost widgetId={widgetId} manifest={manifest} mode="preview" />
      </div>

      {needsConsent && (
        <InstallConsentDialog
          open={consentOpen}
          widgetName={widget.name}
          permissions={manifest.permissions}
          pending={setStatus.isPending}
          onOpenChange={setConsentOpen}
          onConfirm={() =>
            setStatus.mutate(
              { widgetId, status: "enabled" },
              {
                onSuccess: () => setConsentOpen(false),
              },
            )
          }
        />
      )}
    </div>
  );
}
