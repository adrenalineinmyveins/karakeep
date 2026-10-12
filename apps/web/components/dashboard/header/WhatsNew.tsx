"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MarkdownReadonly } from "@/components/ui/markdown/markdown-readonly";
import { useClientConfig } from "@/lib/clientConfig";
import { useTranslation } from "@/lib/i18n/client";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import { z } from "zod";

const GITHUB_OWNER_REPO = "adrenalineinmyveins/karakeep";
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER_REPO}`;
const GITHUB_RELEASE_URL = `${GITHUB_REPO_URL}/releases/tag/`;
const RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER_REPO}/releases/tags/`;
const LOCAL_STORAGE_KEY = "saiye:whats-new:last-seen-version";
const RELEASE_NOTES_STALE_TIME = 1000 * 60 * 10; // 10 minutes

const zGitHubReleaseSchema = z.object({
  body: z.string().optional(),
  tag_name: z.string(),
  name: z.string(),
});

function isStableRelease(version?: string) {
  if (!version) {
    return false;
  }
  const normalized = version.toLowerCase();
  if (
    normalized.includes("nightly") ||
    normalized.includes("beta") ||
    normalized.includes("0.0.1")
  ) {
    return false;
  }
  return true;
}

interface WhatsNewProps {
  // The actual version of the server
  serverVersion?: string;
  // The version that should be displayed in the changelog
  changeLogVersion?: string;
}

/**
 * "What's new" release notes dialog, exposed as an item inside the profile
 * options dropdown menu.
 */
export function WhatsNew({ serverVersion, changeLogVersion }: WhatsNewProps) {
  const { disableNewReleaseCheck } = useClientConfig();
  const { t } = useTranslation();

  const effectiveChangelogVersion = changeLogVersion ?? serverVersion;
  const stableRelease = isStableRelease(effectiveChangelogVersion);
  const displayVersion = serverVersion ?? "unknown";
  const changelogDisplayVersion = effectiveChangelogVersion ?? displayVersion;

  const [open, setOpen] = useState(false);
  const [shouldNotify, setShouldNotify] = useState(false);

  const releaseNotesQuery = useQuery<string>({
    queryKey: ["sidebar-release-notes", effectiveChangelogVersion],
    queryFn: async ({ signal }) => {
      if (!effectiveChangelogVersion) {
        return "";
      }

      const response = await fetch(
        `${RELEASE_API_URL}v${effectiveChangelogVersion}`,
        {
          signal,
        },
      );

      if (!response.ok) {
        throw new Error("Failed to load release notes");
      }

      const json = await response.json();
      const data = zGitHubReleaseSchema.parse(json);
      return data.body ?? "";
    },
    enabled:
      open &&
      stableRelease &&
      !disableNewReleaseCheck &&
      Boolean(effectiveChangelogVersion),
    staleTime: RELEASE_NOTES_STALE_TIME,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const isLoadingReleaseNotes =
    releaseNotesQuery.isLoading && !releaseNotesQuery.data;

  const releaseNotesErrorMessage = useMemo(() => {
    const queryError = releaseNotesQuery.error;
    if (!queryError) {
      return null;
    }

    const errorName =
      queryError instanceof Error
        ? queryError.name
        : typeof (queryError as { name?: unknown })?.name === "string"
          ? String((queryError as { name?: unknown }).name)
          : undefined;

    if (
      errorName === "AbortError" ||
      errorName === "CanceledError" ||
      errorName === "CancelledError"
    ) {
      return null;
    }

    return t("version.unable_to_load_release_notes");
  }, [releaseNotesQuery.error, t]);

  useEffect(() => {
    if (
      !stableRelease ||
      !effectiveChangelogVersion ||
      disableNewReleaseCheck
    ) {
      setShouldNotify(false);
      return;
    }

    try {
      const seenVersion = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      setShouldNotify(seenVersion !== effectiveChangelogVersion);
    } catch (error) {
      console.warn("Failed to read localStorage:", error);
      setShouldNotify(true);
    }
  }, [effectiveChangelogVersion, stableRelease, disableNewReleaseCheck]);

  const markReleaseAsSeen = useCallback(() => {
    if (!effectiveChangelogVersion) return;
    try {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, effectiveChangelogVersion);
    } catch (error) {
      console.warn("Failed to write to localStorage:", error);
      // Ignore failures, we still clear the notification for the session
    }
    setShouldNotify(false);
  }, [effectiveChangelogVersion]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen((prev) => {
        if (prev && !nextOpen) {
          markReleaseAsSeen();
        }
        return nextOpen;
      });
    },
    [markReleaseAsSeen],
  );

  if (!stableRelease || disableNewReleaseCheck) {
    return null;
  }

  return (
    <>
      {/* Keep the dropdown open when opening the dialog so this component
          (and the dialog state) stays mounted. */}
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        aria-label={
          shouldNotify ? t("version.new_release_available") : undefined
        }
      >
        <Sparkles className="mr-2 size-4" />
        <span aria-hidden={shouldNotify}>
          {t("version.whats_new_title", {
            version: changelogDisplayVersion,
          })}
        </span>
        {shouldNotify && (
          <span className="relative ml-auto flex size-2" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
        )}
      </DropdownMenuItem>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {t("version.whats_new_title", {
                version: changelogDisplayVersion,
              })}
            </DialogTitle>
            <DialogDescription>
              {t("version.release_notes_description")}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-2">
            {isLoadingReleaseNotes ? (
              <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <span>{t("version.loading_release_notes")}</span>
              </div>
            ) : releaseNotesErrorMessage ? (
              <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="size-4" aria-hidden="true" />
                <span>{releaseNotesErrorMessage}</span>
              </div>
            ) : releaseNotesQuery.data !== undefined ? (
              releaseNotesQuery.data.trim() ? (
                <MarkdownReadonly className="prose-sm">
                  {releaseNotesQuery.data}
                </MarkdownReadonly>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("version.no_release_notes")}
                </p>
              )
            ) : null}
          </div>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>{t("version.release_notes_synced")}</span>
            <Button asChild variant="link" size="sm" className="px-0">
              <Link
                href={`${GITHUB_RELEASE_URL}v${effectiveChangelogVersion}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("version.view_on_github")}
              </Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
