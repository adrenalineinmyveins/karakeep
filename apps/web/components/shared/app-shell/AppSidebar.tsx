"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import SaiyeLogo from "@/components/SaiyeIcon";
import SidebarVersion from "@/components/shared/sidebar/SidebarVersion";
import { TSidebarItem } from "@/components/shared/sidebar/TSidebarItem";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export function AppSidebar({
  items,
  extraSections,
  serverVersion,
  changeLogVersion,
}: {
  items: TSidebarItem[];
  extraSections?: React.ReactNode;
  serverVersion?: string;
  changeLogVersion?: string;
}) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  // Close the mobile drawer after any in-drawer navigation (main nav or the
  // lists tree) so the visited page is immediately visible. Only reacting to
  // pathname changes keeps opening the drawer itself from closing it.
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="group-data-[collapsible=icon]:hidden">
        <Link
          href="/dashboard/bookmarks"
          aria-label="Home"
          className="block px-2 py-1"
        >
          <SaiyeLogo height={32} />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    tooltip={item.name}
                    isActive={pathname === item.path}
                  >
                    <Link href={item.path}>
                      {item.icon}
                      <span>{item.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {extraSections ? <SidebarGroup>{extraSections}</SidebarGroup> : null}
      </SidebarContent>
      <SidebarFooter>
        <SidebarVersion
          serverVersion={serverVersion}
          changeLogVersion={changeLogVersion}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
