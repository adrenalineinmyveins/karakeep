"use client";

import AgentProfileSettings from "@/components/settings/AgentProfileSettings";
import {
  SettingsPage,
  SettingsSection,
} from "@/components/settings/SettingsPage";
import { useTranslation } from "@/lib/i18n/client";

export default function AgentProfilesSettingsPage() {
  const { t } = useTranslation();
  return (
    <SettingsPage
      title={t("settings.agent_profiles.agent_profiles")}
      description={t("settings.agent_profiles.description")}
    >
      <SettingsSection>
        <AgentProfileSettings />
      </SettingsSection>
    </SettingsPage>
  );
}
