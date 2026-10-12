import { AdminNotices } from "@/components/admin/AdminNotices";
import AppShell from "@/components/shared/app-shell/AppShell";
import { TFunction } from "i18next";
import { Activity, ArrowLeft, Settings, Users, Wrench } from "lucide-react";

const adminSidebarItems = (
  t: TFunction,
): {
  name: string;
  icon: React.ReactElement;
  path: string;
}[] => [
  {
    name: t("settings.back_to_app"),
    icon: <ArrowLeft size={18} />,
    path: "/dashboard/bookmarks",
  },
  {
    name: t("admin.server_stats.server_stats"),
    icon: <Activity size={18} />,
    path: "/admin/overview",
  },
  {
    name: t("admin.users_list.users_list"),
    icon: <Users size={18} />,
    path: "/admin/users",
  },
  {
    name: t("admin.background_jobs.background_jobs"),
    icon: <Settings size={18} />,
    path: "/admin/background_jobs",
  },
  {
    name: t("admin.admin_tools.admin_tools"),
    icon: <Wrench size={18} />,
    path: "/admin/admin_tools",
  },
];

export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AppShell adminOnly withoutUserSettings items={adminSidebarItems}>
      <div className="flex flex-col gap-1">
        <AdminNotices />
        {children}
      </div>
    </AppShell>
  );
}
