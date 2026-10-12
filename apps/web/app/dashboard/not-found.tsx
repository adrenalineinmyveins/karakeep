"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FileQuestion, Home } from "lucide-react";

import { useTranslation } from "@/lib/i18n/client";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center rounded-lg bg-slate-50 p-8 shadow-sm dark:bg-slate-700/50 dark:shadow-md">
      <div className="w-full max-w-md space-y-8 text-center">
        {/* Not Found Icon */}
        <div className="flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <FileQuestion className="h-10 w-10 text-muted-foreground" />
          </div>
        </div>

        {/* Main Content */}
        <div className="space-y-4">
          <h1 className="text-balance text-2xl font-semibold text-foreground">
            {t("error_pages.not_found_title")}
          </h1>
          <p className="text-pretty leading-relaxed text-muted-foreground">
            {t("error_pages.not_found_description")}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="space-y-3">
          <Button className="w-full" onClick={() => window.history.back()}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("error_pages.go_back")}
          </Button>

          <Link href="/" className="block">
            <Button variant="outline" className="w-full">
              <Home className="mr-2 h-4 w-4" />
              {t("error_pages.go_home")}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
