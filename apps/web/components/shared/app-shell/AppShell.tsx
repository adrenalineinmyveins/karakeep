import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import DemoModeBanner from "@/components/DemoModeBanner";
import ErrorFallback from "@/components/dashboard/ErrorFallback";
import Header from "@/components/dashboard/header/Header";
import { AppSidebar } from "@/components/shared/app-shell/AppSidebar";
import { TSidebarItem } from "@/components/shared/sidebar/TSidebarItem";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import LoadingSpinner from "@/components/ui/spinner";
import ValidAccountCheck from "@/components/utils/ValidAccountCheck";
import { useTranslation } from "@/lib/i18n/server";
import { ReaderSettingsProvider } from "@/lib/readerSettings";
import { getUserLocalSettings } from "@/lib/userLocalSettings/userLocalSettings";
import { UserSettingsContextProvider } from "@/lib/userSettings";
import { api } from "@/server/api/client";
import { getServerAuthSession } from "@/server/auth";
import { ErrorBoundary } from "react-error-boundary";
import { TRPCError } from "@trpc/server";
import { TFunction } from "i18next";

import serverConfig from "@saiye/shared/config";
import { tryCatch } from "@saiye/shared/tryCatch";

export interface AppShellProps {
  children: React.ReactNode;
  /** Navigation items rendered in the sidebar. */
  items: (t: TFunction) => TSidebarItem[];
  /** Extra sections rendered below the nav items (e.g. the lists tree). */
  extraSidebarSections?: React.ReactNode;
  /** Intercepting-route modal slot, rendered inside main. */
  modal?: React.ReactNode;
  /** Restrict access to admins (used by the admin area). */
  adminOnly?: boolean;
  /** Skip fetching user settings (the admin area currently runs without them). */
  withoutUserSettings?: boolean;
}

/**
 * Shared application shell: auth guard, user settings prefetch and the
 * sidebar layout wrapper, so route layouts only define their navigation.
 */
export default async function AppShell({
  children,
  items,
  extraSidebarSections,
  modal,
  adminOnly = false,
  withoutUserSettings = false,
}: AppShellProps) {
  const session = await getServerAuthSession();
  if (!session || (adminOnly && session.user.role !== "admin")) {
    redirect("/");
  }

  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  // Mirror the sidebar to the right edge in RTL locales (the <html dir> is
  // derived from the same cookie in the root layout).
  const localSettings = await getUserLocalSettings();
  const side = localSettings.lang === "ar" ? "right" : "left";

  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();

  const shell = (
    <SidebarProvider defaultOpen={defaultOpen} side={side}>
      <AppSidebar
        items={items(t)}
        extraSections={extraSidebarSections}
        serverVersion={serverConfig.serverVersion}
        changeLogVersion={serverConfig.changelogVersion}
      />
      <SidebarInset>
        <Header />
        <ValidAccountCheck />
        <div className="flex-1 bg-muted">
          {serverConfig.demoMode && <DemoModeBanner />}
          {modal}
          <div className="min-h-30 container p-4">
            <ErrorBoundary fallback={<ErrorFallback />}>
              <Suspense fallback={<LoadingSpinner />}>{children}</Suspense>
            </ErrorBoundary>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );

  if (withoutUserSettings) {
    return shell;
  }

  const userSettings = await tryCatch(api.users.settings());
  if (userSettings.error) {
    if (userSettings.error instanceof TRPCError) {
      if (
        userSettings.error.code === "NOT_FOUND" ||
        userSettings.error.code === "UNAUTHORIZED"
      ) {
        redirect("/logout");
      }
    }
    throw userSettings.error;
  }

  return (
    <UserSettingsContextProvider userSettings={userSettings.data}>
      <ReaderSettingsProvider>{shell}</ReaderSettingsProvider>
    </UserSettingsContextProvider>
  );
}
