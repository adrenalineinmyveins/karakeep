import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import "@saiye/tailwind-config/globals.css";

import type { Viewport } from "next";
import React from "react";
import Providers from "@/lib/providers";
import GlobalErrorLogger from "@/components/GlobalErrorLogger";
import { getUserLocalSettings } from "@/lib/userLocalSettings/userLocalSettings";
import { getServerAuthSession } from "@/server/auth";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { Toaster } from "sonner";

import { clientConfig } from "@saiye/shared/config";

const inter = Inter({
  subsets: ["latin"],
  fallback: ["sans-serif"],
});

export const metadata: Metadata = {
  title: "Saiye",
  applicationName: "Saiye",
  description:
    "The Bookmark Everything app. Save links, notes, and images and they will get automatically tagged AI.",
  appleWebApp: {
    capable: true,
    title: "Saiye",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerAuthSession();
  const userSettings = await getUserLocalSettings();
  const isRTL = userSettings.lang === "ar";
  return (
    <html
      lang={userSettings.lang}
      dir={isRTL ? "rtl" : "ltr"}
      suppressHydrationWarning
    >
      <body className={inter.className}>
        <GlobalErrorLogger />
        <NuqsAdapter>
          <Providers
            session={session}
            clientConfig={clientConfig}
            userLocalSettings={await getUserLocalSettings()}
          >
            {children}
            <ReactQueryDevtools initialIsOpen={false} />
          </Providers>
          <Toaster />
        </NuqsAdapter>
      </body>
    </html>
  );
}
