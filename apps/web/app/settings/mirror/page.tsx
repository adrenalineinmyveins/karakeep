"use client";

import MirrorSettings from "@/components/settings/MirrorSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { useTranslation } from "@/lib/i18n/client";

export default function MirrorPage() {
  const { t } = useTranslation();
  return (
    <SettingsPage
      title={t("settings.mirror.page_title")}
      description={t("settings.mirror.page_description")}
    >
      <MirrorSettings />
    </SettingsPage>
  );
}
