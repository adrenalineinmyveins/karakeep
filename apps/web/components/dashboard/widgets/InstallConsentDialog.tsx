"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { widgetPermissionTier } from "@saiye/shared/types/widgets";
import type { ZWidgetPermission } from "@saiye/shared/types/widgets";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n/client";

const tierLabelKey = {
  read: "widgets.tier_read",
  write: "widgets.tier_write",
  delete: "widgets.tier_delete",
} as const;

/** 权限 → i18n 词条键（文案随界面语言切换，替代 shared 包内的硬编码中文） */
const permissionLabelKey = {
  "bookmarks:read": "widgets.perm_bookmarks_read",
  "tags:read": "widgets.perm_tags_read",
  "lists:read": "widgets.perm_lists_read",
  "bookmarks:write": "widgets.perm_bookmarks_write",
  "tags:write": "widgets.perm_tags_write",
  "lists:write": "widgets.perm_lists_write",
  "bookmarks:delete": "widgets.perm_bookmarks_delete",
  "tags:delete": "widgets.perm_tags_delete",
  "lists:delete": "widgets.perm_lists_delete",
} as const satisfies Record<ZWidgetPermission, string>;

/**
 * 安装同意对话框（docs/WIDGET_WRITE_API_DESIGN.md §6.1）：
 * 所有 draft→enabled 且含 L1/L2 权限的转换统一经过此对话框（L0-only 跳过，保持 v0 体验）。
 * 权限按敏感度分级展示；L2（不可逆删除）用警示样式 + 必选勾选框，不勾选无法安装。
 */
export default function InstallConsentDialog({
  open,
  widgetName,
  permissions,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  widgetName: string;
  permissions: ZWidgetPermission[];
  /** 安装请求进行中（按钮 loading） */
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { t } = useTranslation();

  // 每次打开重置勾选（D12：不可逆权限每次安装都要显式同意）
  useEffect(() => {
    if (open) {
      setAcknowledged(false);
    }
  }, [open]);

  const hasL2 = permissions.some((p) => widgetPermissionTier(p) === "delete");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("widgets.install_title", { name: widgetName })}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {t("widgets.install_grants")}
        </p>

        <div className="space-y-3">
          {(["read", "write", "delete"] as const).map((tier) => {
            const group = permissions.filter(
              (p) => widgetPermissionTier(p) === tier,
            );
            if (group.length === 0) return null;
            const isDelete = tier === "delete";
            return (
              <div
                key={tier}
                className={
                  isDelete
                    ? "rounded-md border border-destructive/40 bg-destructive/5 p-3"
                    : "rounded-md border p-3"
                }
              >
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
                  {isDelete && (
                    <TriangleAlert size={14} className="text-destructive" />
                  )}
                  {t(tierLabelKey[tier])}
                  {isDelete && (
                    <span className="text-destructive">
                      {t("widgets.irreversible")}
                    </span>
                  )}
                </div>
                <ul className="space-y-1">
                  {group.map((p) => (
                    <li key={p} className="text-xs leading-relaxed">
                      {t(permissionLabelKey[p])}
                      <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                        {p}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {hasL2 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-destructive"
            />
            <span>{t("widgets.install_ack")}</span>
          </label>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("actions.cancel")}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={pending || (hasL2 && !acknowledged)}
          >
            {t("widgets.install_trust")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
