"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  History,
  Power,
  PowerOff,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";

import { useTRPC } from "@saiye/shared-react/trpc";
import { widgetPermissionTier } from "@saiye/shared/types/widgets";
import type { ZWidgetManifest } from "@saiye/shared/types/widgets";

import { cn } from "@/lib/utils";
import {
  downloadJsonFile,
  readJsonFile,
  safeFilenamePart,
} from "@/lib/assetTransfer";
import { addWidgetActivity, getWidgetActivity } from "@/lib/widgets/audit";
import type { WidgetActivity } from "@/lib/widgets/audit";
import { useTranslation } from "@/lib/i18n/client";
import InstallConsentDialog from "@/components/dashboard/widgets/InstallConsentDialog";
import WidgetHost from "@/components/dashboard/widgets/WidgetHost";
import AssetShareButtons from "@/components/shared/AssetShareButtons";

interface WidgetSummary {
  id: string;
  name: string;
  description: string | null;
  manifest: unknown;
  status: "draft" | "enabled";
  currentVersion: number;
  createdAt: Date;
  modifiedAt: Date | null;
}

export default function WidgetGrid({ widgets }: { widgets: WidgetSummary[] }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  // 启用含 L1/L2 权限的组件需先过分级同意对话框（§6.1）
  const [consentWidget, setConsentWidget] = useState<WidgetSummary | null>(
    null,
  );

  // 活动日志（§7.2）：打开时从 localStorage 读取（写操作由各 WidgetHost 落账）
  const [showActivity, setShowActivity] = useState(false);
  const [activities, setActivities] = useState<WidgetActivity[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const enabled = widgets.filter((w) => w.status === "enabled");
  const drafts = widgets.filter((w) => w.status === "draft");

  const setStatus = useMutation(
    api.widgets.setStatus.mutationOptions({
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries(api.widgets.list.pathFilter());
        // 生命周期审计（§7.2）：安装记录同意的权限快照
        const w = widgets.find((x) => x.id === variables.widgetId);
        if (!w) return;
        const perms = ((w.manifest ?? {}) as ZWidgetManifest).permissions ?? [];
        addWidgetActivity({
          widgetId: w.id,
          widgetName: w.name,
          action:
            variables.status === "enabled"
              ? "widget.install"
              : "widget.disable",
          outcome: "ok",
          summary:
            variables.status === "enabled"
              ? t("widgets.audit_enable", {
                  permissions: perms.join(", ") || t("widgets.audit_none"),
                })
              : t("widgets.audit_disable"),
        });
      },
    }),
  );

  const remove = useMutation(
    api.widgets.delete.mutationOptions({
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries(api.widgets.list.pathFilter());
        const w = widgets.find((x) => x.id === variables.widgetId);
        if (!w) return;
        addWidgetActivity({
          widgetId: w.id,
          widgetName: w.name,
          action: "widget.delete",
          outcome: "ok",
          summary: t("widgets.audit_delete"),
        });
      },
    }),
  );

  // C1 导出：JSON 文件下载
  const exportWidget = useMutation(
    api.widgets.exportAsset.mutationOptions({
      onSuccess: (envelope, variables) => {
        const w = widgets.find((x) => x.id === variables.widgetId);
        downloadJsonFile(
          `saiye-widget-${safeFilenamePart(w?.name ?? "widget")}.json`,
          envelope,
        );
      },
    }),
  );

  // C1 导入：落地为草稿，需手动启用
  const importWidget = useMutation(
    api.widgets.importAsset.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(api.widgets.list.pathFilter());
      },
    }),
  );

  const onImportFile = async (file: File) => {
    try {
      const envelope = await readJsonFile(file);
      importWidget.mutate({ envelope: envelope as never });
    } catch {
      importWidget.reset();
      alert(t("assets.invalid_file"));
    }
  };

  const toggleActivity = () => {
    setActivities(getWidgetActivity());
    setShowActivity((v) => !v);
  };

  const renderCard = (w: WidgetSummary) => {
    const manifest = (w.manifest ?? {}) as ZWidgetManifest;
    const isEnabled = w.status === "enabled";
    // 草稿在同意前视为预览（写被桥拦截），启用后放行写（L2 仍逐次确认）
    const hostMode = isEnabled ? "installed" : "preview";
    const needsConsent = manifest.permissions.some(
      (p) => widgetPermissionTier(p) !== "read",
    );
    const toggle = () => {
      if (isEnabled) {
        // 停用无需确认
        setStatus.mutate({ widgetId: w.id, status: "draft" });
        return;
      }
      if (needsConsent) {
        setConsentWidget(w);
      } else {
        setStatus.mutate({ widgetId: w.id, status: "enabled" });
      }
    };
    return (
      <div
        key={w.id}
        className={cn(
          "flex flex-col rounded-lg border bg-card text-card-foreground shadow-sm",
          w.manifest === undefined && "opacity-60",
        )}
      >
        {/* 头部：名称 + 操作 */}
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{w.name}</span>
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px]",
                  isEnabled
                    ? "bg-green-500/15 text-green-600"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {isEnabled
                  ? t("widgets.status_enabled")
                  : t("widgets.status_draft")}
              </span>
              <span className="text-[10px] text-muted-foreground">
                v{w.currentVersion}
              </span>
            </div>
            {w.description && (
              <p className="truncate text-xs text-muted-foreground">
                {w.description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => exportWidget.mutate({ widgetId: w.id })}
              disabled={exportWidget.isPending}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              title={t("assets.export")}
            >
              <Download size={14} />
            </button>
            <AssetShareButtons bare assetType="widget" assetId={w.id} />
            <button
              type="button"
              onClick={toggle}
              disabled={setStatus.isPending}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              title={isEnabled ? t("widgets.disable") : t("widgets.enable")}
            >
              {isEnabled ? <PowerOff size={14} /> : <Power size={14} />}
            </button>
            <button
              type="button"
              onClick={() => remove.mutate({ widgetId: w.id })}
              disabled={remove.isPending}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              title={t("actions.delete")}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* 沙箱主体 */}
        <div className="p-3">
          {w.manifest === undefined ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              {t("widgets.broken_manifest")}
            </div>
          ) : (
            <WidgetHost widgetId={w.id} manifest={manifest} mode={hostMode} />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* 活动入口（§7.2）：组件写操作与生命周期事件，本设备最近 100 条 */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggleActivity}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <History size={13} />
          {t("widgets.activity")}
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={importWidget.isPending}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Upload size={13} />
          {t("assets.import")}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              onImportFile(file);
            }
            e.target.value = "";
          }}
        />
        {showActivity && (
          <div className="mt-2 rounded-lg border bg-card p-3">
            {activities.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("widgets.no_activity")}
              </p>
            ) : (
              <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                {activities.map((a) => (
                  <li key={a.id} className="flex items-baseline gap-2 text-xs">
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {new Date(a.ts).toLocaleString(undefined, {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="shrink-0 font-medium">{a.widgetName}</span>
                    <span
                      className={cn(
                        "min-w-0",
                        a.outcome === "error"
                          ? "text-destructive"
                          : a.outcome === "denied"
                            ? "text-amber-600"
                            : "text-muted-foreground",
                      )}
                    >
                      {a.summary}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {enabled.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("widgets.enabled_count", { count: enabled.length })}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {enabled.map(renderCard)}
          </div>
        </section>
      )}

      {drafts.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("widgets.drafts_count", { count: drafts.length })}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {drafts.map(renderCard)}
          </div>
        </section>
      )}

      {widgets.length === 0 && (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
          <p className="text-lg font-medium">{t("widgets.empty_title")}</p>
          <p className="text-sm text-muted-foreground">
            {t("widgets.empty_hint")}
          </p>
        </div>
      )}

      {consentWidget && (
        <InstallConsentDialog
          open
          widgetName={consentWidget.name}
          permissions={
            ((consentWidget.manifest ?? {}) as ZWidgetManifest).permissions
          }
          pending={setStatus.isPending}
          onOpenChange={(open) => {
            if (!open) setConsentWidget(null);
          }}
          onConfirm={() =>
            setStatus.mutate(
              { widgetId: consentWidget.id, status: "enabled" },
              {
                onSuccess: () => setConsentWidget(null),
              },
            )
          }
        />
      )}
    </div>
  );
}
