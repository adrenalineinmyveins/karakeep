import AppShell from "@/components/shared/app-shell/AppShell";
import { TFunction } from "i18next";
import {
  ArrowLeft,
  BarChart3,
  Bot,
  CloudDownload,
  CreditCard,
  Download,
  FileText,
  GitBranch,
  Image,
  Info,
  KeyRound,
  Link,
  Rss,
  Sparkles,
  User,
  Webhook,
} from "lucide-react";

import serverConfig from "@saiye/shared/config";

const settingsSidebarItems = (
  t: TFunction,
): {
  name: string;
  icon: React.ReactElement;
  path: string;
}[] => {
  return [
    {
      name: t("settings.back_to_app"),
      icon: <ArrowLeft size={18} />,
      path: "/dashboard/bookmarks",
    },
    {
      name: t("settings.info.user_info"),
      icon: <User size={18} />,
      path: "/settings/info",
    },
    {
      name: t("settings.stats.usage_statistics"),
      icon: <BarChart3 size={18} />,
      path: "/settings/stats",
    },
    ...(serverConfig.stripe.isConfigured
      ? [
          {
            name: t("settings.subscription.subscription"),
            icon: <CreditCard size={18} />,
            path: "/settings/subscription",
          },
        ]
      : []),
    ...(serverConfig.inference.isConfigured
      ? [
          {
            name: t("settings.ai.ai_settings"),
            icon: <Sparkles size={18} />,
            path: "/settings/ai",
          },
        ]
      : []),
    {
      name: t("settings.feeds.rss_subscriptions"),
      icon: <Rss size={18} />,
      path: "/settings/feeds",
    },
    {
      name: t("settings.backups.backups"),
      icon: <CloudDownload size={18} />,
      path: "/settings/backups",
    },
    ...(serverConfig.mirrorExport.enabled
      ? [
          {
            name: t("settings.mirror.mirror_export"),
            icon: <FileText size={18} />,
            path: "/settings/mirror",
          },
        ]
      : []),
    {
      name: t("settings.import.import_export"),
      icon: <Download size={18} />,
      path: "/settings/import",
    },
    {
      name: t("settings.api_keys.api_keys"),
      icon: <KeyRound size={18} />,
      path: "/settings/api-keys",
    },
    {
      name: t("settings.broken_links.broken_links"),
      icon: <Link size={18} />,
      path: "/settings/broken-links",
    },
    {
      name: t("settings.webhooks.webhooks"),
      icon: <Webhook size={18} />,
      path: "/settings/webhooks",
    },
    {
      name: t("settings.agent_profiles.agent_profiles"),
      icon: <Bot size={18} />,
      path: "/settings/agents",
    },
    {
      name: t("settings.rules.rules"),
      icon: <GitBranch size={18} />,
      path: "/settings/rules",
    },
    {
      name: t("settings.about.about"),
      icon: <Info size={18} />,
      path: "/settings/about",
    },
    {
      name: t("settings.manage_assets.manage_assets"),
      icon: <Image size={18} />,
      path: "/settings/assets",
    },
  ];
};

export default async function SettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AppShell items={settingsSidebarItems}>{children}</AppShell>;
}
