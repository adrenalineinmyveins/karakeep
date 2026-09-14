import CanvasList from "@/components/dashboard/canvas/CanvasList";
import { useTranslation } from "@/lib/i18n/server";
import { api } from "@/server/api/client";

export default async function CanvasListPage() {
  const canvases = await api.canvases.listCanvases();
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl tracking-normal text-foreground">
          🎨 {t("canvas.title")}
        </h1>
        <p className="text-md text-muted-foreground">
          {t("canvas.subtitle", { count: canvases.length })}
        </p>
      </div>
      <CanvasList initialCanvases={canvases} />
    </div>
  );
}
