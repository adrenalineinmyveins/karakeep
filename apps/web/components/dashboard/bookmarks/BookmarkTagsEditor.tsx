import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";

import type { ZBookmark } from "@saiye/shared/types/bookmarks";
import { useUpdateBookmarkTags } from "@saiye/shared-react/hooks/bookmarks";

import { TagsEditor } from "./TagsEditor";

export function BookmarkTagsEditor({
  bookmark,
  disabled,
}: {
  bookmark: ZBookmark;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { mutate } = useUpdateBookmarkTags({
    onSuccess: () => {
      toast({
        description: t("toasts.tags.updated"),
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: t("common.something_went_wrong"),
        description: t("common.request_problem"),
      });
    },
  });

  return (
    <TagsEditor
      tags={bookmark.tags}
      disabled={disabled}
      onAttach={({ tagName, tagId }) => {
        mutate({
          bookmarkId: bookmark.id,
          attach: [
            {
              tagName,
              tagId,
            },
          ],
          detach: [],
        });
      }}
      onDetach={({ tagId }) => {
        mutate({
          bookmarkId: bookmark.id,
          attach: [],
          detach: [{ tagId }],
        });
      }}
    />
  );
}
