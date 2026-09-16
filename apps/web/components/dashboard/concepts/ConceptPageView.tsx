"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import { MarkdownReadonly } from "@/components/ui/markdown/markdown-readonly";
import RelativeTime from "@/components/ui/relative-time";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Hash,
  ListIcon,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { useTRPC } from "@saiye/shared-react/trpc";

// Reading view for a single compiled concept page. Polls while a compilation
// is in flight; the previous content stays readable during recompiles.
export default function ConceptPageView({ slug }: { slug: string }) {
  const api = useTRPC();
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data, error } = useQuery(
    api.concepts.get.queryOptions(
      { slug },
      {
        refetchInterval: (query) => {
          const s = query.state.data?.concept.status;
          return s === "pending" || s === "generating" ? 3000 : false;
        },
      },
    ),
  );

  const onError = () =>
    toast({ description: t("concepts.toasts.failed"), variant: "destructive" });
  const recompileMutation = useMutation(
    api.concepts.recompile.mutationOptions({
      onSuccess: () => {
        toast({ description: t("concepts.toasts.recompile_queued") });
        queryClient.invalidateQueries(api.concepts.get.pathFilter());
      },
      onError,
    }),
  );
  const deleteMutation = useMutation(
    api.concepts.delete.mutationOptions({
      onSuccess: () => {
        toast({ description: t("concepts.toasts.deleted") });
        queryClient.invalidateQueries(api.concepts.list.pathFilter());
        router.push("/dashboard/concepts");
      },
      onError,
    }),
  );

  if (error?.data?.code === "NOT_FOUND") {
    router.push("/dashboard/concepts");
  }
  if (!data) {
    return null;
  }

  const { concept, content, anchorName, sources } = data;
  const isCompiling =
    concept.status === "pending" || concept.status === "generating";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/dashboard/concepts"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("concepts.title")}
        </Link>
        <div className="flex items-center gap-2">
          <ActionButton
            variant="secondary"
            size="sm"
            loading={recompileMutation.isPending}
            disabled={isCompiling}
            onClick={() => recompileMutation.mutate({ conceptId: concept.id })}
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
                onClick={() => deleteMutation.mutate({ conceptId: concept.id })}
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
      </div>

      <div>
        <h1 className="text-3xl font-semibold leading-tight">{concept.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            {concept.anchorType === "tag" ? (
              <Hash className="size-3.5" />
            ) : (
              <ListIcon className="size-3.5" />
            )}
            {anchorName ??
              t(
                concept.anchorType === "tag"
                  ? "concepts.anchor_tag"
                  : "concepts.anchor_list",
              )}
          </span>
          <span aria-hidden>·</span>
          <span>{t("concepts.sources_count", { count: concept.sourceCount })}</span>
          {concept.lastCompiledAt && (
            <>
              <span aria-hidden>·</span>
              <span className="flex items-center gap-1">
                {t("concepts.compiled")}
                <RelativeTime date={concept.lastCompiledAt} />
              </span>
            </>
          )}
          {concept.status === "stale" && (
            <Badge variant="secondary">{t("concepts.stale_badge")}</Badge>
          )}
          {concept.status === "failure" && (
            <Badge variant="destructive">{t("concepts.failed_badge")}</Badge>
          )}
        </div>
      </div>

      {isCompiling && content && (
        <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
          {t("concepts.generating_page")}
        </div>
      )}
      {isCompiling && !content && (
        <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
          {t("concepts.generating")}
        </div>
      )}
      {concept.status === "failure" && concept.lastError && (
        <div className="rounded-xl border border-destructive/50 p-3 text-sm text-destructive">
          {t("concepts.failure_hint")}: {concept.lastError}
        </div>
      )}

      <MarkdownReadonly className="max-w-none">
        {content || ""}
      </MarkdownReadonly>

      {sources.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{t("concepts.sources")}</h2>
          <ol className="flex flex-col gap-1.5 text-sm">
            {sources.map((source, idx) => (
              <li key={source.bookmarkId} className="flex items-start gap-2">
                <span className="text-muted-foreground">[{idx + 1}]</span>
                <Link
                  href={`/preview/${source.bookmarkId}`}
                  className="min-w-0 break-words hover:underline"
                >
                  {source.title ?? source.bookmarkId}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
