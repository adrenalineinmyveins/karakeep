import type { Metadata } from "next";

import DiscoverGrid from "@/components/dashboard/discover/DiscoverGrid";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("discover.title")} | Saiye`,
  };
}

export default function DiscoverPage() {
  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl tracking-normal text-foreground">
          <DiscoverTitle />
        </h1>
      </div>
      <DiscoverGrid />
    </div>
  );
}

async function DiscoverTitle() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return <>{t("discover.title")}</>;
}
