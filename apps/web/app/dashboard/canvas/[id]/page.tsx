import { notFound } from "next/navigation";

import CanvasEditor from "@/components/dashboard/canvas/CanvasEditor";
import { api } from "@/server/api/client";

export default async function CanvasEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let canvas;
  try {
    canvas = await api.canvases.getCanvas({ canvasId: id });
  } catch {
    notFound();
  }

  return <CanvasEditor canvas={canvas} />;
}
