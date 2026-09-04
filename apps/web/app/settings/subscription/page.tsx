import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SettingsPage } from "@/components/settings/SettingsPage";
import SubscriptionSettings from "@/components/settings/SubscriptionSettings";
import { QuotaProgress } from "@/components/subscription/QuotaProgress";
import { useTranslation } from "@/lib/i18n/server";

import serverConfig from "@saiye/shared/config";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("settings.subscription.subscription")} | Saiye`,
  };
}

export default async function SubscriptionPage() {
  if (!serverConfig.stripe.isConfigured) {
    redirect("/settings");
  }

  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();

  return (
    <SettingsPage title={t("settings.subscription.subscription")}>
      <SubscriptionSettings />
      <QuotaProgress />
    </SettingsPage>
  );
}
