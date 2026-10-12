import { redirect } from "next/navigation";
import GlobalActions from "@/components/dashboard/GlobalActions";
import ProfileOptions from "@/components/dashboard/header/ProfileOptions";
import { SearchInput } from "@/components/dashboard/search/SearchInput";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { getServerAuthSession } from "@/server/auth";

import serverConfig from "@saiye/shared/config";

export default async function Header() {
  const session = await getServerAuthSession();
  if (!session) {
    redirect("/");
  }

  return (
    <header className="sticky top-0 z-50 flex h-[var(--header-height)] items-center gap-2 bg-background p-4 shadow">
      <SidebarTrigger />
      <div className="flex flex-1 gap-2">
        <SearchInput className="rounded-md bg-muted" />
        <GlobalActions />
      </div>
      <div className="flex items-center">
        <ProfileOptions
          serverVersion={serverConfig.serverVersion}
          changeLogVersion={serverConfig.changelogVersion}
        />
      </div>
    </header>
  );
}
