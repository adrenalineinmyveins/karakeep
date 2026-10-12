import AllLists from "@/components/dashboard/sidebar/AllLists";
import AppShell from "@/components/shared/app-shell/AppShell";
import { api } from "@/server/api/client";
import { TFunction } from "i18next";
import {
  Archive,
  BookOpenText,
  Compass,
  Highlighter,
  Home,
  LayoutDashboard,
  MessageCircle,
  MessagesSquare,
  Paintbrush,
  Search,
  Tag,
} from "lucide-react";

import { PluginManager, PluginType } from "@saiye/shared/plugins";
import { tryCatch } from "@saiye/shared/tryCatch";

import serverConfig from "@saiye/shared/config";

const items = (t: TFunction) =>
  [
    {
      name: t("common.home"),
      icon: <Home size={18} />,
      path: "/dashboard/bookmarks",
    },
    PluginManager.isRegistered(PluginType.Search)
      ? [
          {
            name: t("common.search"),
            icon: <Search size={18} />,
            path: "/dashboard/search",
          },
        ]
      : [],
    {
      name: t("common.tags"),
      icon: <Tag size={18} />,
      path: "/dashboard/tags",
    },
    ...(serverConfig.inference.isConfigured
      ? [
          {
            name: t("concepts.title"),
            icon: <BookOpenText size={18} />,
            path: "/dashboard/concepts",
          },
        ]
      : []),
    {
      name: t("common.highlights"),
      icon: <Highlighter size={18} />,
      path: "/dashboard/highlights",
    },
    {
      name: t("common.canvas"),
      icon: <Paintbrush size={18} />,
      path: "/dashboard/canvas",
    },
    {
      name: t("common.widgets"),
      icon: <LayoutDashboard size={18} />,
      path: "/dashboard/widgets",
    },
    {
      name: t("discover.title"),
      icon: <Compass size={18} />,
      path: "/dashboard/discover",
    },
    {
      name: t("common.archive"),
      icon: <Archive size={18} />,
      path: "/dashboard/archive",
    },
    ...(serverConfig.chat.enabled
      ? [
          {
            name: t("common.chat"),
            icon: <MessageCircle size={18} />,
            path: "/dashboard/chat",
          },
          {
            name: t("common.consult"),
            icon: <MessagesSquare size={18} />,
            path: "/dashboard/consult",
          },
        ]
      : []),
  ].flat();

export default async function Dashboard({
  children,
  modal,
}: Readonly<{
  children: React.ReactNode;
  modal: React.ReactNode;
}>) {
  const lists = await tryCatch(api.lists.list());
  if (lists.error) {
    throw lists.error;
  }

  return (
    <AppShell
      items={items}
      extraSidebarSections={<AllLists initialData={lists.data} />}
      modal={modal}
    >
      {children}
    </AppShell>
  );
}
