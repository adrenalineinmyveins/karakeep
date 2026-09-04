import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { SettingsPage, SettingsSection } from "@/components/settings/SettingsPage";
import SaiyeLogo from "@/components/SaiyeIcon";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslation } from "@/lib/i18n/server";

import serverConfig from "@saiye/shared/config";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("settings.about.about")} | Saiye`,
  };
}

export default async function AboutPage() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();

  return (
    <SettingsPage
      title={t("settings.about.about")}
      description={t("settings.about.description")}
    >
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.about.version")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <SaiyeLogo height={40} />
          <div>
            <p className="font-medium">Saiye v{serverConfig.serverVersion}</p>
            <CardDescription>
              {t("settings.about.description")}
            </CardDescription>
          </div>
        </CardContent>
      </Card>

      <SettingsSection title={t("settings.about.based_on_title")}>
        <p className="text-sm text-muted-foreground">
          {t("settings.about.based_on_description")}
        </p>
        <a
          href="https://karakeep.app"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t("settings.about.karakeep_website")}
          <ExternalLink size={14} />
        </a>
      </SettingsSection>

      <SettingsSection title={t("settings.about.license")}>
        <p className="text-sm text-muted-foreground">
          {t("settings.about.license_description")}
        </p>
        <Link
          href="https://www.gnu.org/licenses/agpl-3.0.html"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t("settings.about.view_license")}
          <ExternalLink size={14} />
        </Link>
      </SettingsSection>
    </SettingsPage>
  );
}
