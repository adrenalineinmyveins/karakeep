/**
 * Agent 工具集测试
 *
 * 覆盖 create_canvas 的全部分支：
 * - mermaid 正常 / 缺参 / 非法语法
 * - 书签卡片正常 / 非链接书签 / 悬空 links
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock 基础设施 ─────────────────────────────────────────

const fakeCaller = {
  bookmarks: {
    searchBookmarks: vi.fn(),
    getBookmark: vi.fn(),
    createBookmark: vi.fn(),
    updateTags: vi.fn(),
  },
  tags: { list: vi.fn() },
  lists: { list: vi.fn(), addToList: vi.fn() },
  canvases: { createCanvas: vi.fn() },
};

// 拦截 createCallerFactory，让 getCaller 返回 fakeCaller
vi.mock("../../index", () => ({
  createCallerFactory: () => (_ctx: unknown) => fakeCaller,
}));

// 隔离真实路由树：getCaller 会动态 import _app 并拉起全部 router，
// 其中顶层的 createScopedAuthedProcedure 依赖上面未完整 mock 的 ../../index
vi.mock("../../routers/_app", () => ({ appRouter: {} }));

vi.mock("@plait-board/mermaid-to-drawnix", () => ({
  parseMermaidToDrawnix: vi.fn(),
}));

// eslint-disable-next-line import/first
import { parseMermaidToDrawnix } from "@plait-board/mermaid-to-drawnix";
// eslint-disable-next-line import/first
import { buildAgentTools, buildBookmarkCanvasElements } from "./tools";

const ctx = { user: { id: "user-1" } } as never;

const linkBookmark = (id: string, title: string) => ({
  id,
  title,
  content: {
    type: "link",
    url: `https://example.com/${id}`,
    favicon: `https://example.com/${id}/favicon.ico`,
    description: null,
  },
  tags: [],
});

async function getCreateCanvasTool() {
  const tools = await buildAgentTools(ctx);
  const tool = tools.find((t) => t.name === "create_canvas");
  if (!tool) throw new Error("create_canvas tool not found");
  return tool;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildAgentTools", () => {
  it("包含 create_canvas 工具（无 Tavily key 时共 9 个）", async () => {
    const tools = await buildAgentTools(ctx);
    expect(tools.map((t) => t.name)).toContain("create_canvas");
    expect(tools).toHaveLength(9);
  });
});

describe("create_bookmark", () => {
  async function getCreateBookmarkTool() {
    const tools = await buildAgentTools(ctx);
    const tool = tools.find((t) => t.name === "create_bookmark");
    if (!tool) throw new Error("create_bookmark tool not found");
    return tool;
  }

  it("text 参数 → 创建 TEXT 书签", async () => {
    fakeCaller.bookmarks.createBookmark.mockResolvedValue({
      id: "bm-text-1",
      title: null,
      alreadyExists: false,
    });

    const tool = await getCreateBookmarkTool();
    const raw = await tool.execute({ text: "一段要保存的文章全文……" });
    const result = JSON.parse(raw);

    expect(fakeCaller.bookmarks.createBookmark).toHaveBeenCalledWith({
      type: "text",
      text: "一段要保存的文章全文……",
    });
    expect(result.id).toBe("bm-text-1");
  });

  it("url 参数 → 仍创建 LINK 书签", async () => {
    fakeCaller.bookmarks.createBookmark.mockResolvedValue({
      id: "bm-link-1",
      title: "示例",
      alreadyExists: false,
    });

    const tool = await getCreateBookmarkTool();
    await tool.execute({ url: "https://example.com/a" });

    expect(fakeCaller.bookmarks.createBookmark).toHaveBeenCalledWith({
      type: "link",
      url: "https://example.com/a",
    });
  });

  it("url 与 text 都缺 → 返回参数错误，不创建书签", async () => {
    const tool = await getCreateBookmarkTool();
    const raw = await tool.execute({});
    const result = JSON.parse(raw);

    expect(result.error).toContain("url 或 text");
    expect(fakeCaller.bookmarks.createBookmark).not.toHaveBeenCalled();
  });
});

describe("create_canvas：mermaid 模式", () => {
  it(
    "正常 mermaid 语法 → 转换元素并创建画布",
    { timeout: 60_000 },
    async () => {
      vi.mocked(parseMermaidToDrawnix).mockResolvedValue({
        elements: [{ id: "m-1", type: "geometry" }],
      } as never);
      fakeCaller.canvases.createCanvas.mockResolvedValue({
        id: "canvas-1",
        title: "测试画布",
      });

      const tool = await getCreateCanvasTool();
      const raw = await tool.execute({
        description: "用户下单流程",
        title: "下单流程图",
        mermaid: "graph TD; A[下单]-->B[支付]",
      });
      const result = JSON.parse(raw);

      expect(parseMermaidToDrawnix).toHaveBeenCalledWith(
        "graph TD; A[下单]-->B[支付]",
      );
      expect(fakeCaller.canvases.createCanvas).toHaveBeenCalledWith({
        title: "下单流程图",
        data: [{ id: "m-1", type: "geometry" }],
      });
      expect(result).toEqual({
        id: "canvas-1",
        title: "测试画布",
        editUrl: "/dashboard/canvas/canvas-1",
        elementCount: 1,
      });
    },
  );

  it("缺 mermaid 且缺 bookmarkNodes → 返回参数错误，不建画布", async () => {
    const tool = await getCreateCanvasTool();
    const raw = await tool.execute({ description: "一张图" });
    const result = JSON.parse(raw);

    expect(result.error).toContain("缺少 mermaid 或 bookmarkNodes");
    expect(fakeCaller.canvases.createCanvas).not.toHaveBeenCalled();
  });

  it(
    "非法 mermaid 语法 → 返回转换失败错误",
    { timeout: 60_000 },
    async () => {
      vi.mocked(parseMermaidToDrawnix).mockRejectedValue(
        new Error("Parse error"),
      );

      const tool = await getCreateCanvasTool();
      const raw = await tool.execute({
        description: "坏语法",
        mermaid: "this is not @ valid mermaid !!!",
      });
      const result = JSON.parse(raw);

      expect(result.error).toContain("mermaid 转 drawnix 失败");
      expect(result.mermaid).toBe("this is not @ valid mermaid !!!");
      expect(fakeCaller.canvases.createCanvas).not.toHaveBeenCalled();
    },
  );
});

describe("create_canvas：书签模式", () => {
  it("正常书签列表 → 网格卡片 + 字段完备的连线", async () => {
    fakeCaller.bookmarks.getBookmark.mockImplementation(
      async ({ bookmarkId }: { bookmarkId: string }) =>
        linkBookmark(bookmarkId, `书签${bookmarkId}`),
    );
    fakeCaller.canvases.createCanvas.mockResolvedValue({
      id: "canvas-2",
      title: "书签图谱",
    });

    const tool = await getCreateCanvasTool();
    const raw = await tool.execute({
      description: "书签关系网络",
      bookmarkNodes: ["bm1", "bm2"],
      links: [{ source: "bm1", target: "bm2" }],
    });
    const result = JSON.parse(raw);

    expect(result.elementCount).toBe(3); // 2 卡片 + 1 连线

    const createCall = fakeCaller.canvases.createCanvas.mock.calls[0][0];
    const [card1, card2, line] = createCall.data;

    // 卡片逐字段（与编辑器手绘元素对齐）
    expect(card1).toEqual({
      id: "card-bm1",
      type: "geometry",
      shape: "rectangle",
      bookmarkId: "bm1",
      title: "书签bm1",
      url: "https://example.com/bm1",
      favicon: "https://example.com/bm1/favicon.ico",
      points: [
        [0, 0],
        [256, 88],
      ],
      opacity: 1,
    });
    expect(card2.points).toEqual([
      [336, 0],
      [336 + 256, 88],
    ]); // 第二列 = 256 + 80 间距

    // 连线逐字段（texts/strokeWidth/marker 缺一即渲染崩溃）
    expect(line).toEqual({
      id: "link-0",
      type: "arrow-line",
      shape: "straight",
      source: { marker: "none", boundId: "card-bm1", connection: [0.5, 0] },
      target: { marker: "arrow", boundId: "card-bm2", connection: [0.5, 1] },
      texts: [],
      strokeWidth: 2,
      points: [
        [0 + 128, 0],
        [336 + 128, 88],
      ],
      opacity: 1,
    });
  });

  it("非链接书签（text 类型）→ 返回类型错误", async () => {
    fakeCaller.bookmarks.getBookmark.mockResolvedValue({
      id: "bm-text",
      title: "笔记",
      content: { type: "text", text: "一段笔记" },
      tags: [],
    });

    const tool = await getCreateCanvasTool();
    const raw = await tool.execute({
      description: "导入笔记",
      bookmarkNodes: ["bm-text"],
    });
    const result = JSON.parse(raw);

    expect(result.error).toContain("不是链接类型");
    expect(fakeCaller.canvases.createCanvas).not.toHaveBeenCalled();
  });

  it("悬空 links（引用不在 bookmarkNodes 中的 id）→ 返回错误", async () => {
    fakeCaller.bookmarks.getBookmark.mockImplementation(
      async ({ bookmarkId }: { bookmarkId: string }) =>
        linkBookmark(bookmarkId, `书签${bookmarkId}`),
    );

    const tool = await getCreateCanvasTool();
    const raw = await tool.execute({
      description: "悬空连线",
      bookmarkNodes: ["bm1"],
      links: [{ source: "bm1", target: "bm-not-exist" }],
    });
    const result = JSON.parse(raw);

    expect(result.error).toContain("书签卡片构造失败");
    expect(result.error).toContain("bm-not-exist");
    expect(fakeCaller.canvases.createCanvas).not.toHaveBeenCalled();
  });

  it(
    "已有 mermaid 元素时书签卡片从 x=600 错开摆放",
    { timeout: 60_000 },
    async () => {
      vi.mocked(parseMermaidToDrawnix).mockResolvedValue({
        elements: [{ id: "m-1", type: "geometry" }],
      } as never);
      fakeCaller.bookmarks.getBookmark.mockImplementation(
        async ({ bookmarkId }: { bookmarkId: string }) =>
          linkBookmark(bookmarkId, `书签${bookmarkId}`),
      );
      fakeCaller.canvases.createCanvas.mockResolvedValue({
        id: "canvas-3",
        title: "组合",
      });

      const tool = await getCreateCanvasTool();
      const raw = await tool.execute({
        description: "组合画布",
        mermaid: "graph TD; A-->B",
        bookmarkNodes: ["bm1"],
      });
      JSON.parse(raw);

      const createCall = fakeCaller.canvases.createCanvas.mock.calls[0][0];
      const card = createCall.data.find(
        (e: { id: string }) => e.id === "card-bm1",
      );
      expect(card.points[0]).toEqual([600, 0]);
    },
  );
});

describe("buildBookmarkCanvasElements：网格布局", () => {
  it("每行 3 张，第 4 张换行", () => {
    const bookmarks = ["a", "b", "c", "d"].map((id) => ({
      id,
      title: `t-${id}`,
      url: `https://x.com/${id}`,
      favicon: null,
    }));
    const elements = buildBookmarkCanvasElements(bookmarks, []);

    expect(elements).toHaveLength(4);
    const d = elements[3];
    // 第 4 张：row=1, col=0 → y = 88 + 80
    expect(d.points).toEqual([
      [0, 168],
      [256, 168 + 88],
    ]);
  });
});
