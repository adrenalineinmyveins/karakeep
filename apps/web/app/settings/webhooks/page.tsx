import type { Metadata } from "next";
import WebhookSettings from "@/components/settings/WebhookSettings";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("settings.webhooks.webhooks")} | Saiye`,
  };
}

export default function WebhookSettingsPage() {
  return <WebhookSettings />;
}
