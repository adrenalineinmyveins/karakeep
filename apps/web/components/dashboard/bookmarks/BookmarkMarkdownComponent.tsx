import MarkdownEditor from "@/components/ui/markdown/markdown-editor";
import { MarkdownReadonly } from "@/components/ui/markdown/markdown-readonly";
import { toast } from "@/components/ui/sonner";
import { useTranslation } from "@/lib/i18n/client";

import { useUpdateBookmark } from "@saiye/shared-react/hooks/bookmarks";

export function BookmarkMarkdownComponent({
  children: bookmark,
  readOnly = true,
}: {
  children: {
    id: string;
    content: {
      text: string;
    };
  };
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { mutate: updateBookmarkMutator, isPending } = useUpdateBookmark({
    onSuccess: () => {
      toast({
        description: t("toasts.bookmarks.note_updated"),
      });
    },
    onError: () => {
      toast({
        description: t("common.something_went_wrong"),
        variant: "destructive",
      });
    },
  });

  const onSave = (text: string) => {
    updateBookmarkMutator({
      bookmarkId: bookmark.id,
      text,
    });
  };

  return (
    <div className="h-full">
      {readOnly ? (
        <MarkdownReadonly onSave={onSave}>
          {bookmark.content.text}
        </MarkdownReadonly>
      ) : (
        <MarkdownEditor onSave={onSave} isSaving={isPending}>
          {bookmark.content.text}
        </MarkdownEditor>
      )}
    </div>
  );
}
