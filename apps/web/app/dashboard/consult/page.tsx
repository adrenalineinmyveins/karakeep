import type { Metadata } from "next";

import ConsultGrid from "@/components/dashboard/consult/ConsultGrid";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("common.consult")} | Saiye`,
  };
}

export default function ConsultPage() {
  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl tracking-normal text-foreground">
          <ConsultTitle />
        </h1>
      </div>
      <ConsultGrid />
    </div>
  );
}

async function ConsultTitle() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return <>{t("common.consult")}</>;
}
