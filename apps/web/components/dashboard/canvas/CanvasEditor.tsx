"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, BookmarkPlus, Check, Loader2, Network, Pencil, Trash2 } from "lucide-react";
import { getViewBoxCenterPoint, PlaitBoard, Transforms } from "@plait/core";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";

import BookmarkPickerDialog from "./BookmarkPickerDialog";
import {
  attachBookmarkCardToMind,
  bookmarkCardPlugins,
  createBookmarkCard,
  isBookmarkCard,
  normalizeCanvasValue,
  removeBookmarkCard,
  type BookmarkCardElement,
} from "./plugins/withBookmarkCard";

// @drawnix 生态三个包的 exports 都只暴露了 JS 入口，无法用包名子路径引 CSS，
// 只能用相对路径引入（5 层向上到仓库根的 node_modules）。三份缺一不可：
// - drawnix：工具栏定位、按钮/弹窗样式
// - react-board：画板容器核心布局（.plait-board-container / .viewport-container）
// - react-text：文本编辑层（slate 可编辑容器）
import "../../../../../node_modules/@drawnix/drawnix/index.css";
import "../../../../../node_modules/@plait-board/react-board/index.css";
import "../../../../../node_modules/@plait-board/react-text/index.css";

const Drawnix = dynamic(
  () => import("@drawnix/drawnix").then((m) => m.Drawnix),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    ),
  },
);

type CanvasData = {
  id: string;
  title: string;
  data: unknown;
  createdAt: Date;
  modifiedAt: Date | null;
};

// embedded：独立路由模式（/canvas/[id]，无 dashboard 头部），
// 全屏高度且不渲染返回按钮（主要供移动端 WebView 使用）
export default function CanvasEditor({
  canvas,
  embedded = false,
}: {
  canvas: CanvasData;
  embedded?: boolean;
}) {
  const api = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(canvas.title);
  // 加载时规范化旧版书签卡片数据（type: 'bookmarkCard' → geometry 两点式），
  // 保存时自然写回新格式
  const [value, setValue] = useState<unknown[]>(
    Array.isArray(canvas.data)
      ? normalizeCanvasValue(canvas.data as never[])
      : [],
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  // 右键菜单（屏幕坐标）与编辑对话框草稿
  const [cardMenu, setCardMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [editDraft, setEditDraft] = useState<{
    id: string;
    title: string;
    url: string;
  } | null>(null);

  // Drawnix 初始化后拿 board 引用，用于程序化插入元素
  const boardRef = useRef<PlaitBoard | null>(null);

  // 按 id 找到画布中当前的书签卡片（编辑/删除可能发生在元素对象被替换后）
  const findCardById = (
    id: string,
  ): BookmarkCardElement | undefined =>
    boardRef.current?.children.find(
      (c): c is BookmarkCardElement => c.id === id && isBookmarkCard(c),
    );

  const deleteCard = (id: string) => {
    const board = boardRef.current;
    const card = findCardById(id);
    if (!board || !card) return;
    // 统一走插件删除入口：连带清理绑定到卡片的连线，避免 boundId 悬空
    removeBookmarkCard(board, card);
  };

  const saveCardEdit = () => {
    const board = boardRef.current;
    if (!board || !editDraft) return;
    const card = findCardById(editDraft.id);
    if (card) {
      const path = PlaitBoard.findPath(board, card);
      Transforms.setNode(
        board,
        { title: editDraft.title, url: editDraft.url },
        path,
      );
    }
    setEditDraft(null);
  };

  const insertBookmark = (bookmark: {
    id: string;
    content: {
      type: string;
      title?: string | null;
      url?: string | null;
      favicon?: string | null;
    };
  }) => {
    const board = boardRef.current;
    // host 未注册（画布卸载竞态）时 getViewBoxCenterPoint 会取 undefined.viewBox
    if (!board || !PlaitBoard.getHost(board)) return;
    const c = bookmark.content;
    if (c.type !== "link" || !c.url) return;
    const center = getViewBoxCenterPoint(board);
    // plait 的 API 是 insertNode（单数，需显式 path），不是 slate 风格的 insertNodes
    Transforms.insertNode(
      board,
      createBookmarkCard(
        {
          bookmarkId: bookmark.id,
          title: c.title ?? c.url,
          url: c.url,
          favicon: c.favicon,
        },
        center,
      ),
      [board.children.length],
    );
  };

  const updateCanvas = useMutation(
    api.canvases.updateCanvas.mutationOptions({
      onMutate: () => setSaveState("saving"),
      onSuccess: () => {
        setSaveState("saved");
        queryClient.invalidateQueries(api.canvases.listCanvases.pathFilter());
        setTimeout(() => setSaveState("idle"), 1500);
      },
      onError: () => setSaveState("idle"),
    }),
  );

  // 防抖保存：数据变化后 1.5s 自动保存
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValue = useRef(value);
  latestValue.current = value;

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateCanvas.mutate({
        canvasId: canvas.id,
        data: latestValue.current,
      });
    }, 1500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 右键菜单：点击菜单外任意位置时关闭
  useEffect(() => {
    if (!cardMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest("[data-card-menu]")) {
        setCardMenu(null);
      }
    };
    // 延迟到下一个任务挂载，避免与打开菜单的右键事件竞争
    const timer = setTimeout(
      () => document.addEventListener("pointerdown", onPointerDown),
      0,
    );
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [cardMenu]);

  // 标题防抖
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (title === canvas.title) return;
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => {
      updateCanvas.mutate({
        canvasId: canvas.id,
        title,
        data: latestValue.current,
      });
    }, 800);
    return () => {
      if (titleTimer.current) clearTimeout(titleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  return (
    <div
      className={
        embedded
          ? "flex h-screen flex-col"
          : "flex h-[calc(100vh-64px)] flex-col"
      }
    >
      <div className="flex items-center gap-3 border-b px-4 py-2">
        {!embedded && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => router.push("/dashboard/canvas")}
          >
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 max-w-md border-none px-2 text-base font-medium shadow-none focus-visible:ring-1"
        />
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {saveState === "saving" && (
            <>
              <Loader2 className="size-3 animate-spin" />
              <span>保存中…</span>
            </>
          )}
          {saveState === "saved" && (
            <>
              <Check className="size-3 text-green-600" />
              <span>已保存</span>
            </>
          )}
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <Drawnix
          value={value as never}
          onValueChange={(v) => setValue(v as unknown[])}
          plugins={bookmarkCardPlugins}
          afterInit={(board) => {
            boardRef.current = board;
            // 插件右键命中书签卡片时，记录元素与屏幕坐标以渲染浮动菜单
            board.openBookmarkCardMenu = (element, clientPoint) => {
              setCardMenu({
                id: element.id,
                x: clientPoint[0],
                y: clientPoint[1],
              });
            };
          }}
        />
        {/* 插入书签浮动按钮（左下角，避开 drawnix 自带的工具栏） */}
        <Button
          size="sm"
          variant="outline"
          className="absolute bottom-4 left-4 z-10 gap-1.5 bg-background shadow-md"
          onClick={() => setPickerOpen(true)}
        >
          <BookmarkPlus className="size-4" />
          插入书签
        </Button>
        <BookmarkPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={insertBookmark}
        />
        {/* 书签卡片右键菜单（fixed 定位跟随鼠标位置，防溢出视口） */}
        {cardMenu && (
          <div
            data-card-menu
            className="fixed z-50 flex w-32 flex-col rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            style={{
              left: Math.min(cardMenu.x, window.innerWidth - 140),
              top: Math.min(cardMenu.y, window.innerHeight - 130),
            }}
          >
            <button
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                const card = findCardById(cardMenu.id);
                if (card) {
                  setEditDraft({
                    id: card.id,
                    title: card.title,
                    url: card.url,
                  });
                }
                setCardMenu(null);
              }}
            >
              <Pencil className="size-3.5" />
              编辑
            </button>
            <button
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                const board = boardRef.current;
                const card = findCardById(cardMenu.id);
                if (board && card) {
                  attachBookmarkCardToMind(board, card);
                }
                setCardMenu(null);
              }}
            >
              <Network className="size-3.5" />
              加入思维导图
            </button>
            <button
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-red-600 hover:bg-accent"
              onClick={() => {
                deleteCard(cardMenu.id);
                setCardMenu(null);
              }}
            >
              <Trash2 className="size-3.5" />
              删除
            </button>
          </div>
        )}
        {/* 编辑书签卡片对话框 */}
        <Dialog
          open={!!editDraft}
          onOpenChange={(open) => !open && setEditDraft(null)}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>编辑书签卡片</DialogTitle>
            </DialogHeader>
            {editDraft && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted-foreground">标题</span>
                  <Input
                    value={editDraft.title}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, title: e.target.value })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm text-muted-foreground">链接</span>
                  <Input
                    value={editDraft.url}
                    onChange={(e) =>
                      setEditDraft({ ...editDraft, url: e.target.value })
                    }
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setEditDraft(null)}>
                    取消
                  </Button>
                  <Button onClick={saveCardEdit}>保存</Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
