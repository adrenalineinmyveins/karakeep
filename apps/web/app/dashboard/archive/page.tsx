import type { Metadata } from "next";
import Bookmarks from "@/components/dashboard/bookmarks/Bookmarks";
import InfoTooltip from "@/components/ui/info-tooltip";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("common.archive")} | Saiye`,
  };
}

export default async function ArchivedBookmarkPage() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return (
    <Bookmarks
      header={
        <div className="flex gap-2">
          <p className="text-2xl">🗄️ {t("common.archive")}</p>
          <InfoTooltip size={17} className="my-auto" variant="explain">
            <p>{t("common.archived_bookmarks_hint")}</p>
          </InfoTooltip>
        </div>
      }
      query={{ archived: true }}
      showDivider={true}
      showEditorCard={true}
    />
  );
}
