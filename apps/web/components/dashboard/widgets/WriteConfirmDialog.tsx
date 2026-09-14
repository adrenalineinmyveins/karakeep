"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

import { useTRPC } from "@saiye/shared-react/trpc";

import { useTranslation } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type WidgetConfirmTargetKind = "bookmark" | "tag" | "list";

const kindLabelKey = {
  bookmark: "widgets.kind_bookmark",
  tag: "widgets.kind_tag",
  list: "widgets.kind_list",
} as const;

/**
 * L2 删除运行时逐次确认（docs/WIDGET_WRITE_API_DESIGN.md §6.2）。
 * 目标摘要由宿主从真实数据 best-effort 拉取（失败回退 ID 前 8 位），
 * 绝不显示组件自报的描述（不可信）。不提供"不再询问"（D12）。
 */
export default function WriteConfirmDialog({
  open,
  widgetName,
  kind,
  targetId,
  onResolve,
}: {
  open: boolean;
  widgetName: string;
  kind: WidgetConfirmTargetKind;
  targetId: string;
  /** 用户点击后回调（true=允许执行，false=拒绝） */
  onResolve: (allow: boolean) => void;
}) {
  const api = useTRPC();
  const { t } = useTranslation();

  // best-effort 目标摘要：拉不到（已删/网络失败）就显示 ID 前 8 位
  const bookmarkQuery = useQuery({
    ...api.bookmarks.getBookmark.queryOptions({ bookmarkId: targetId }),
    enabled: open && kind === "bookmark",
    retry: false,
  });
  const tagsQuery = useQuery({
    ...api.tags.list.queryOptions(),
    enabled: open && kind === "tag",
    retry: false,
  });
  const listsQuery = useQuery({
    ...api.lists.list.queryOptions(),
    enabled: open && kind === "list",
    retry: false,
  });

  let summary: string | null = null;
  if (kind === "bookmark") {
    const title = bookmarkQuery.data?.title;
    summary = typeof title === "string" && title.length > 0 ? title : null;
  } else if (kind === "tag") {
    summary = tagsQuery.data?.tags.find((t) => t.id === targetId)?.name ?? null;
  } else {
    summary =
      listsQuery.data?.lists.find((l) => l.id === targetId)?.name ?? null;
  }
  const targetLabel = summary ? `《${summary}》` : `#${targetId.slice(0, 8)}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onResolve(false);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert size={16} className="text-destructive" />
            {t("widgets.confirm_title")}
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm leading-relaxed">
          {t("widgets.confirm_body", {
            name: widgetName,
            kind: t(kindLabelKey[kind]),
          })}
        </p>
        <p className="break-all rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm font-medium">
          {targetLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("widgets.confirm_note")}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onResolve(false)}>
            {t("widgets.confirm_deny")}
          </Button>
          <Button variant="destructive" onClick={() => onResolve(true)}>
            {t("actions.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
