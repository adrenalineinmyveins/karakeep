import type { Metadata } from "next";

import ConsultInbox from "@/components/dashboard/consult/ConsultInbox";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("consult.inbox_title")} | Saiye`,
  };
}

export default function ConsultInboxPage() {
  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl tracking-normal text-foreground">
          <InboxTitle />
        </h1>
      </div>
      <ConsultInbox />
    </div>
  );
}

async function InboxTitle() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return <>{t("consult.inbox_title")}</>;
}
