import CanvasList from "@/components/dashboard/canvas/CanvasList";
import { api } from "@/server/api/client";

export default async function CanvasListPage() {
  const canvases = await api.canvases.listCanvases();

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl tracking-normal text-foreground">
          🎨 画布
        </h1>
        <p className="text-md text-muted-foreground">
          共 {canvases.length} 个画布
        </p>
      </div>
      <CanvasList initialCanvases={canvases} />
    </div>
  );
}
