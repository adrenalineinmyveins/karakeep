"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@saiye/shared-react/trpc";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";

type CanvasSummary = {
  id: string;
  title: string;
  createdAt: Date;
  modifiedAt: Date | null;
};

export default function CanvasList({
  initialCanvases,
}: {
  initialCanvases: CanvasSummary[];
}) {
  const api = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const createCanvas = useMutation(
    api.canvases.createCanvas.mutationOptions({
      onSuccess: (canvas) => {
        queryClient.invalidateQueries(api.canvases.listCanvases.pathFilter());
        router.push(`/dashboard/canvas/${canvas.id}`);
      },
    }),
  );

  const deleteCanvas = useMutation(
    api.canvases.deleteCanvas.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(api.canvases.listCanvases.pathFilter());
      },
    }),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          className="h-11 gap-2 rounded-lg"
          onClick={() => createCanvas.mutate({})}
          disabled={createCanvas.isPending}
        >
          <Plus className="size-4" />
          <span>新建画布</span>
        </Button>
      </div>

      {initialCanvases.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <Plus className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            还没有画布，点击右上角创建第一个吧
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {initialCanvases.map((canvas) => (
            <div
              key={canvas.id}
              className="group relative flex flex-col gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/50"
            >
              <Link
                href={`/dashboard/canvas/${canvas.id}`}
                className="flex flex-1 flex-col gap-2"
              >
                <div className="flex h-32 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                  <Plus className="size-6 opacity-40" />
                </div>
                <h3 className="line-clamp-1 text-sm font-medium">
                  {canvas.title}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {canvas.modifiedAt
                    ? `${formatDistanceToNow(new Date(canvas.modifiedAt), { addSuffix: true, locale: zhCN })}更新`
                    : `${formatDistanceToNow(new Date(canvas.createdAt), { addSuffix: true, locale: zhCN })}创建`}
                </p>
              </Link>
              <button
                className="absolute right-2 top-2 rounded-md bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  if (confirm(`删除「${canvas.title}」？此操作不可撤销`)) {
                    deleteCanvas.mutate({ canvasId: canvas.id });
                  }
                }}
              >
                <Trash2
                  size={14}
                  className="text-muted-foreground hover:text-destructive"
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
