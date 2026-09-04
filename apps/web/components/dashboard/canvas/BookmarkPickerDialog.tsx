"use client";

/**
 * 画布书签选择器：搜索并选择一个书签，插入为画布上的书签卡片元素
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bookmark as BookmarkIcon, Globe, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTRPC } from "@saiye/shared-react/trpc";
import { getBookmarkTitle } from "@saiye/shared/utils/bookmarkUtils";

import type { ZBookmark } from "@saiye/shared/types/bookmarks";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (bookmark: ZBookmark) => void;
}

export default function BookmarkPickerDialog({
  open,
  onOpenChange,
  onPick,
}: Props) {
  const api = useTRPC();
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery(
    api.bookmarks.getBookmarks.queryOptions(
      { limit: 50, useCursorV2: true },
      { enabled: open },
    ),
  );

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const bookmarks = useMemo(() => {
    const list = data?.bookmarks ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => {
      const title = (getBookmarkTitle(b) ?? "").toLowerCase();
      const url = b.content.type === "link" ? (b.content.url ?? "") : "";
      return title.includes(q) || url.toLowerCase().includes(q);
    });
  }, [data, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[70vh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>插入书签到画布</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-4 text-gray-400" />
          <Input
            autoFocus
            placeholder="搜索书签标题或链接…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="max-h-[45vh] overflow-y-auto">
          {isLoading && (
            <div className="flex justify-center py-8 text-gray-400">
              加载中…
            </div>
          )}
          {!isLoading && bookmarks.length === 0 && (
            <div className="py-8 text-center text-gray-400">没有匹配的书签</div>
          )}
          <div className="flex flex-col gap-1">
            {bookmarks.map((b) => {
              const favicon =
                b.content.type === "link" ? b.content.favicon : null;
              const url = b.content.type === "link" ? b.content.url : "";
              return (
                <button
                  key={b.id}
                  className={cn(
                    "flex items-center gap-3 rounded-md border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-accent",
                  )}
                  onClick={() => {
                    onPick(b);
                    onOpenChange(false);
                  }}
                >
                  {favicon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={favicon}
                      alt=""
                      className="size-5 shrink-0 rounded"
                    />
                  ) : (
                    <BookmarkIcon className="size-5 shrink-0 text-gray-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {getBookmarkTitle(b) ?? "Untitled"}
                    </div>
                    <div className="flex items-center gap-1 truncate text-xs text-gray-400">
                      <Globe className="size-3 shrink-0" />
                      <span className="truncate">{url || "非链接书签"}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
