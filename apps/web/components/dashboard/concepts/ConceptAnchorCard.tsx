"use client";

import Link from "next/link";
import { ActionButton } from "@/components/ui/action-button";
import { Badge } from "@/components/ui/badge";
import RelativeTime from "@/components/ui/relative-time";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenText, RefreshCw, Sparkles } from "lucide-react";

import { useTRPC } from "@saiye/shared-react/trpc";

// Inline entry card on tag/list pages showing the concept page status for
// that anchor. Hidden entirely when inference is not configured.
export default function ConceptAnchorCard({
  anchorType,
  anchorId,
}: {
  anchorType: "tag" | "list";
  anchorId: string;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: status } = useQuery(
    api.concepts.anchorStatus.queryOptions(
      { anchorType, anchorId },
      {
        // Keep polling while a compilation is in flight
        refetchInterval: (query) => {
          const s = query.state.data?.status;
          return s === "pending" || s === "generating" ? 3000 : false;
        },
      },
    ),
  );

  const onError = () =>
    toast({ description: t("concepts.toasts.failed"), variant: "destructive" });
  const invalidate = () =>
    queryClient.invalidateQueries(api.concepts.anchorStatus.pathFilter());

  const createMutation = useMutation(
    api.concepts.create.mutationOptions({
      onSuccess: () => {
        toast({ description: t("concepts.toasts.created") });
        invalidate();
      },
      onError,
    }),
  );

  const recompileMutation = useMutation(
    api.concepts.recompile.mutationOptions({
      onSuccess: () => {
        toast({ description: t("concepts.toasts.recompile_queued") });
        invalidate();
      },
      onError,
    }),
  );

  if (!status || !status.inferenceConfigured) {
    return null;
  }

  // No concept page for this anchor yet: offer to create one
  if (!status.status) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BookOpenText className="size-4" />
          {t("concepts.entry_hint")}
        </div>
        <ActionButton
          variant="secondary"
          size="sm"
          loading={createMutation.isPending}
          onClick={() => createMutation.mutate({ anchorType, anchorId })}
        >
          <Sparkles className="mr-1 size-4" />
          {t("concepts.generate")}
        </ActionButton>
      </div>
    );
  }

  const isCompiling =
    status.status === "pending" || status.status === "generating";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <BookOpenText className="size-4 text-muted-foreground" />
        {isCompiling ? (
          <span className="text-muted-foreground">{t("concepts.generating")}</span>
        ) : (
          <Link
            href={`/dashboard/concepts/${status.slug}`}
            className="font-medium hover:underline"
          >
            {t("concepts.view_page")}
          </Link>
        )}
        {status.status === "stale" && (
          <Badge variant="secondary">{t("concepts.stale_badge")}</Badge>
        )}
        {status.status === "failure" && (
          <Badge variant="destructive">{t("concepts.failed_badge")}</Badge>
        )}
        {status.sourceCount !== null && status.sourceCount > 0 && (
          <span className="text-muted-foreground">
            {t("concepts.sources_count", { count: status.sourceCount })}
          </span>
        )}
        {status.lastCompiledAt && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <span aria-hidden>·</span>
            <RelativeTime date={status.lastCompiledAt} />
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!isCompiling && (
          <ActionButton
            variant="secondary"
            size="sm"
            loading={recompileMutation.isPending}
            onClick={() =>
              status.conceptId &&
              recompileMutation.mutate({ conceptId: status.conceptId })
            }
          >
            <RefreshCw className="mr-1 size-4" />
            {t("concepts.recompile")}
          </ActionButton>
        )}
      </div>
    </div>
  );
}
