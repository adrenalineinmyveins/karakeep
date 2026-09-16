"use client";

import Link from "next/link";
import { ActionButton } from "@/components/ui/action-button";
import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import { Badge } from "@/components/ui/badge";
import RelativeTime from "@/components/ui/relative-time";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, Hash, ListIcon, RefreshCw, Trash2 } from "lucide-react";

import { useTRPC } from "@saiye/shared-react/trpc";

// Overview of all compiled concept pages.
export default function ConceptsOverview() {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data } = useQuery(api.concepts.list.queryOptions());

  const onError = () =>
    toast({ description: t("concepts.toasts.failed"), variant: "destructive" });
  const invalidate = () => {
    queryClient.invalidateQueries(api.concepts.list.pathFilter());
    queryClient.invalidateQueries(api.concepts.anchorStatus.pathFilter());
  };

  const recompileMutation = useMutation(
    api.concepts.recompile.mutationOptions({
      onSuccess: () => {
        toast({ description: t("concepts.toasts.recompile_queued") });
        invalidate();
      },
      onError,
    }),
  );
  const deleteMutation = useMutation(
    api.concepts.delete.mutationOptions({
      onSuccess: () => {
        toast({ description: t("concepts.toasts.deleted") });
        invalidate();
      },
      onError,
    }),
  );

  const concepts = data?.concepts ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t("concepts.title")}</h1>

      {concepts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
          <BookOpenText className="size-8 text-muted-foreground" />
          <p className="font-medium">{t("concepts.overview_empty_title")}</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("concepts.overview_empty_hint")}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {concepts.map((concept) => {
            const isCompiling =
              concept.status === "pending" || concept.status === "generating";
            return (
              <li
                key={concept.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                  {concept.anchorType === "tag" ? (
                    <Hash className="size-4 text-muted-foreground" />
                  ) : (
                    <ListIcon className="size-4 text-muted-foreground" />
                  )}
                  <Link
                    href={`/dashboard/concepts/${concept.slug}`}
                    className="font-medium hover:underline"
                  >
                    {concept.title}
                  </Link>
                  {concept.status === "stale" && (
                    <Badge variant="secondary">
                      {t("concepts.stale_badge")}
                    </Badge>
                  )}
                  {concept.status === "failure" && (
                    <Badge variant="destructive">
                      {t("concepts.failed_badge")}
                    </Badge>
                  )}
                  {isCompiling && (
                    <span className="text-muted-foreground">
                      {t("concepts.generating")}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    {t("concepts.sources_count", {
                      count: concept.sourceCount,
                    })}
                  </span>
                  {concept.lastCompiledAt && (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <span aria-hidden>·</span>
                      <RelativeTime date={concept.lastCompiledAt} />
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ActionButton
                    variant="secondary"
                    size="sm"
                    loading={recompileMutation.isPending}
                    disabled={isCompiling}
                    onClick={() =>
                      recompileMutation.mutate({ conceptId: concept.id })
                    }
                  >
                    <RefreshCw className="mr-1 size-4" />
                    {t("concepts.recompile")}
                  </ActionButton>
                  <ActionConfirmingDialog
                    title={t("concepts.delete_confirm_title")}
                    description={t("concepts.delete_confirm_description")}
                    actionButton={() => (
                      <ActionButton
                        type="button"
                        variant="destructive"
                        loading={deleteMutation.isPending}
                        onClick={() =>
                          deleteMutation.mutate({ conceptId: concept.id })
                        }
                      >
                        <Trash2 className="mr-2 size-4" />
                        {t("actions.delete")}
                      </ActionButton>
                    )}
                  >
                    <ActionButton
                      variant="ghost"
                      size="icon"
                      loading={deleteMutation.isPending}
                      aria-label={t("concepts.delete_confirm_title")}
                    >
                      <Trash2 className="size-4" />
                    </ActionButton>
                  </ActionConfirmingDialog>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
