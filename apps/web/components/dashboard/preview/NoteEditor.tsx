import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { useClientConfig } from "@/lib/clientConfig";
import { useTranslation } from "@/lib/i18n/client";

import type { ZBookmark } from "@saiye/shared/types/bookmarks";
import { useUpdateBookmark } from "@saiye/shared-react/hooks/bookmarks";

export function NoteEditor({
  bookmark,
  disabled,
}: {
  bookmark: ZBookmark;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const demoMode = !!useClientConfig().demoMode;

  const updateBookmarkMutator = useUpdateBookmark({
    onSuccess: () => {
      toast({
        description: t("actions.bookmark_updated"),
      });
    },
    onError: () => {
      toast({
        description: t("actions.note_save_failed"),
        variant: "destructive",
      });
    },
  });

  return (
    <Textarea
      className="min-h-[5rem] w-full resize-y overflow-auto rounded-md bg-background p-2.5 text-sm text-foreground placeholder:text-muted-foreground"
      defaultValue={bookmark.note ?? ""}
      disabled={demoMode || disabled}
      placeholder={t("preview.note_placeholder")}
      onBlur={(e) => {
        if (e.currentTarget.value == bookmark.note) {
          return;
        }
        updateBookmarkMutator.mutate({
          bookmarkId: bookmark.id,
          note: e.currentTarget.value,
        });
      }}
    />
  );
}
