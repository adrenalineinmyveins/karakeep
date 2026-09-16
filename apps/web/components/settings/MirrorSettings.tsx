"use client";

import React from "react";
import { ActionButton } from "@/components/ui/action-button";
import { FullPageSpinner } from "@/components/ui/full-page-spinner";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSync, RefreshCw } from "lucide-react";

import { useTRPC } from "@saiye/shared-react/trpc";

import { SettingsSection } from "./SettingsPage";

export default function MirrorSettings() {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery(
    api.mirror.status.queryOptions(),
  );

  const { mutate: rebuild, isPending: isRebuilding } = useMutation(
    api.mirror.rebuild.mutationOptions({
      onSuccess: () => {
        toast({
          description: t("settings.mirror.rebuild_queued"),
        });
      },
      onError: (error) => {
        toast({
          description: `Error: ${error.message}`,
          variant: "destructive",
        });
      },
    }),
  );

  if (isLoading) {
    return <FullPageSpinner />;
  }

  return (
    <SettingsSection title={t("settings.mirror.mirror_export")}>
      {!status?.enabled ? (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          {t("settings.mirror.disabled_description")}
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">
                {t("settings.mirror.export_dir")}
              </span>
              <span className="break-all font-mono">{status.dir}</span>
            </div>
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="text-muted-foreground">
                {t("settings.mirror.file_count")}
              </span>
              <span>{status.fileCount.toLocaleString()}</span>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("settings.mirror.description")}
          </p>
          <ActionButton
            onClick={() => {
              rebuild();
              // File count changes as the worker progresses
              setTimeout(
                () =>
                  queryClient.invalidateQueries(api.mirror.status.pathFilter()),
                5000,
              );
            }}
            loading={isRebuilding}
            variant="outline"
            className="items-center"
          >
            {isRebuilding ? (
              <RefreshCw className="mr-2 size-4" />
            ) : (
              <FolderSync className="mr-2 size-4" />
            )}
            {t("settings.mirror.rebuild_now")}
          </ActionButton>
        </>
      )}
    </SettingsSection>
  );
}
