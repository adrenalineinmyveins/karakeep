import WidgetGrid from "@/components/dashboard/widgets/WidgetGrid";
import { useTranslation } from "@/lib/i18n/server";
import { api } from "@/server/api/client";

export default async function WidgetsPage() {
  const widgets = await api.widgets.list();
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl tracking-normal text-foreground">
          {t("widgets.title")}
        </h1>
        <p className="text-md text-muted-foreground">
          {t("widgets.subtitle", { count: widgets.length })}
        </p>
      </div>
      <WidgetGrid widgets={widgets} />
    </div>
  );
}
