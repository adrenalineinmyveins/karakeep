"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@saiye/shared-react/trpc";
import { formatDistanceToNow } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";

import { useTranslation } from "@/lib/i18n/client";

interface CanvasSummary {
  id: string;
  title: string;
  createdAt: Date;
  modifiedAt: Date | null;
}

export default function CanvasList({
  initialCanvases,
}: {
  initialCanvases: CanvasSummary[];
}) {
  const api = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language.startsWith("zh") ? zhCN : enUS;

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
          <span>{t("canvas.new_canvas")}</span>
        </Button>
      </div>

      {initialCanvases.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <Plus className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {t("canvas.empty_hint")}
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
                    ? t("canvas.updated_at", {
                        time: formatDistanceToNow(new Date(canvas.modifiedAt), {
                          addSuffix: true,
                          locale: dateLocale,
                        }),
                      })
                    : t("canvas.created_at", {
                        time: formatDistanceToNow(new Date(canvas.createdAt), {
                          addSuffix: true,
                          locale: dateLocale,
                        }),
                      })}
                </p>
              </Link>
              <button
                className="absolute right-2 top-2 rounded-md bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  if (
                    confirm(t("canvas.delete_confirm", { title: canvas.title }))
                  ) {
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
