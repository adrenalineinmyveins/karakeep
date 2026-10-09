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
  widgets: {
    save: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    rollback: vi.fn(),
  },
  users: { settings: vi.fn(), updateSettings: vi.fn() },
  feeds: { create: vi.fn(), list: vi.fn(), delete: vi.fn(), fetchNow: vi.fn() },
};

// 拦截 createCallerFactory，让 getCaller 返回 fakeCaller，
// 并记录每次 caller 的 ctx（验证咨询工具集的身份切换）
const callerCtxs: unknown[] = [];
vi.mock("../../index", () => ({
  createCallerFactory: () => (c: unknown) => {
    callerCtxs.push(c);
    return fakeCaller;
  },
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
import {
  buildAgentTools,
  buildBookmarkCanvasElements,
  buildConsultationTools,
  disableMemoryToolsForConsultation,
} from "./tools";

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
  it("包含 create_canvas 工具（无 Tavily key 时共 22 个）", async () => {
    const tools = await buildAgentTools(ctx);
    expect(tools.map((t) => t.name)).toContain("create_canvas");
    expect(tools).toHaveLength(22);
  });

  it("包含全部 widget 工具，且 save_widget 描述内嵌组件规范", async () => {
    const tools = await buildAgentTools(ctx);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "save_widget",
        "update_widget",
        "list_widgets",
        "delete_widget",
        "rollback_widget",
      ]),
    );
    const save = tools.find((t) => t.name === "save_widget")!;
    expect(save.description).toContain("Widget 组件规范");
    expect(save.description).toContain("saiye.bookmarks.recent");
  });
});

describe("disableMemoryToolsForConsultation (D4)", () => {
  it("记忆三工具执行器替换为固定错误，其余工具原样保留", async () => {
    const tools = await buildAgentTools(ctx);
    const disabled = disableMemoryToolsForConsultation(tools);

    for (const name of ["save_memory", "list_memories", "delete_memory"]) {
      const tool = disabled.find((t) => t.name === name);
      if (!tool) throw new Error(`${name} tool not found`);
      const result = JSON.parse(await tool.execute({}));
      expect(result.error).toContain("咨询会话");
    }

    // 非记忆工具不受影响（同引用）
    const search = disabled.find((t) => t.name === "search_bookmarks")!;
    expect(search).toBe(tools.find((t) => t.name === "search_bookmarks"));
  });
});

// ── 咨询会话工具集（owner 只读知识工具） ───────────────

/** 模拟 ctx.db.select().from().where().limit() 链（buildConsultationTools 查 owner） */
function fakeOwnerDb(owner?: { id: string; name: string | null }) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (owner ? [owner] : []),
        }),
      }),
    }),
  } as never;
}

/** 咨询者 ctx（user-1）+ 注入 owner 查询 db */
function consultationCtx(db: unknown) {
  return { user: { id: "user-1" }, db } as never;
}

describe("buildConsultationTools（咨询 owner 只读工具）", () => {
  it("以 owner 身份构建工具：caller ctx 的 user 切换为专家所有者", async () => {
    callerCtxs.length = 0;
    await buildConsultationTools(
      consultationCtx(fakeOwnerDb({ id: "owner-1", name: "专家" })),
      "owner-1",
    );
    expect(callerCtxs.at(-1)).toMatchObject({ user: { id: "owner-1" } });
  });

  it("写操作与个人域工具执行器替换为固定错误，定义保留", async () => {
    const db = fakeOwnerDb({ id: "owner-1", name: null });
    const tools = await buildConsultationTools(consultationCtx(db), "owner-1");

    const blocked = [
      "create_bookmark",
      "add_to_list",
      "attach_tag",
      "create_canvas",
      "save_memory",
      "list_memories",
      "delete_memory",
      "save_widget",
      "list_widgets",
      "get_user_settings",
      "update_user_settings",
      "subscribe_feed",
      "list_feeds",
    ];
    for (const name of blocked) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`${name} tool not found`);
      const result = JSON.parse(await tool.execute({}));
      expect(result.error).toContain("咨询会话");
    }
  });

  it("只读知识工具保持可用，search_bookmarks 描述切换为专家语义", async () => {
    const db = fakeOwnerDb({ id: "owner-1", name: null });
    const tools = await buildConsultationTools(consultationCtx(db), "owner-1");

    const search = tools.find((t) => t.name === "search_bookmarks")!;
    expect(search.description).toContain("专家自己的书签知识库");
    // 执行器透传到 fakeCaller，输出经脱敏（空结果 → "[]"）
    fakeCaller.bookmarks.searchBookmarks.mockResolvedValueOnce({
      bookmarks: [],
    });
    expect(await search.execute({ query: "rust" })).toBe("[]");
    expect(fakeCaller.bookmarks.searchBookmarks).toHaveBeenCalled();
  });

  it("咨询 search_bookmarks 输出脱敏：剥离 title/url", async () => {
    const db = fakeOwnerDb({ id: "owner-1", name: null });
    const tools = await buildConsultationTools(consultationCtx(db), "owner-1");

    fakeCaller.bookmarks.searchBookmarks.mockResolvedValueOnce({
      bookmarks: [
        {
          id: "bm-1",
          title: "私有标题",
          summary: "摘要内容",
          content: {
            type: "link",
            url: "https://secret.example/private",
            description: "公开网页描述",
          },
        },
      ],
    });
    const out = await tools
      .find((t) => t.name === "search_bookmarks")!
      .execute({ query: "rust", limit: 5 });

    expect(out).not.toContain("secret.example");
    expect(out).not.toContain("私有标题");
    expect(JSON.parse(out)).toEqual([
      {
        id: "bm-1",
        summary: "摘要内容",
        description: "公开网页描述",
        sanitized: true,
      },
    ]);
  });

  it("咨询 get_bookmark_detail 输出脱敏：剥离 url/note/highlights/资产", async () => {
    const db = fakeOwnerDb({ id: "owner-1", name: null });
    const tools = await buildConsultationTools(consultationCtx(db), "owner-1");

    fakeCaller.bookmarks.getBookmark.mockResolvedValueOnce({
      id: "bm-1",
      title: "私有标题",
      note: "专家的私有笔记",
      highlights: [{ text: "私有高亮" }],
      summary: "摘要内容",
      content: { type: "text", text: "正文片段" },
      assets: [{ id: "asset-1", content: "YmFzZTY0..." }],
    });
    const out = await tools
      .find((t) => t.name === "get_bookmark_detail")!
      .execute({ bookmarkId: "bm-1" });

    expect(out).not.toContain("私有笔记");
    expect(out).not.toContain("私有高亮");
    expect(out).not.toContain("YmFzZTY0");
    expect(JSON.parse(out)).toEqual({
      id: "bm-1",
      summary: "摘要内容",
      content: "正文片段",
      sanitized: true,
    });
  });

  it("owner 不存在时抛错", async () => {
    await expect(
      buildConsultationTools(consultationCtx(fakeOwnerDb()), "nope"),
    ).rejects.toThrow("Consultation owner not found");
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
    "mermaid 线锚点越界/悬空 → 重锚到节点边框（端点贴框）",
    { timeout: 60_000 },
    async () => {
      // 真实 parseMermaidToDrawnix 输出片段：折线端点带 gap，
      // 换算出的 connection 越界（y=-0.5075）或悬在框内（0.6875）
      vi.mocked(parseMermaidToDrawnix).mockResolvedValue({
        elements: [
          {
            id: "nodeA",
            type: "geometry",
            points: [
              [42.5, 12.5],
              [142.5, 52.5],
            ],
          },
          {
            id: "nodeB",
            type: "geometry",
            points: [
              [35, 125],
              [135, 165],
            ],
          },
          {
            id: "line1",
            type: "arrow-line",
            points: [
              [50, 40],
              [50, 65],
              [50, 104.7],
            ],
            source: {
              marker: "none",
              boundId: "nodeA",
              connection: [0.075, 0.6875],
            },
            target: {
              marker: "arrow",
              boundId: "nodeB",
              connection: [0.15, -0.5075],
            },
          },
        ],
      } as never);
      fakeCaller.canvases.createCanvas.mockResolvedValue({
        id: "canvas-1",
        title: "测试画布",
      });

      const tool = await getCreateCanvasTool();
      await tool.execute({
        description: "垂直流程",
        mermaid: "graph TD; A-->B",
      });

      const data = fakeCaller.canvases.createCanvas.mock.calls[0]![0].data;
      const line = data.find(
        (e: { type: string }) => e.type === "arrow-line",
      ) as {
        source: { connection: number[] };
        target: { connection: number[] };
      };
      // 折线垂直向下 → 源下边中点 / 目标上边中点
      expect(line.source.connection).toEqual([0.5, 1]);
      expect(line.target.connection).toEqual([0.5, 0]);
    },
  );

  it(
    "flowchart 整齐化重排：分层对齐 + 统一尺寸 + 轴向直线连线",
    { timeout: 60_000 },
    async () => {
      // 乱坐标的分支图：A→{B,C}，{B,C}→D（真实转换产物中
      // 节点中心不对齐、连线歪斜）
      const mkLine = (id: string, s: string, t: string) => ({
        id,
        type: "arrow-line",
        points: [
          [Math.random() * 50, Math.random() * 50],
          [Math.random() * 50 + 100, Math.random() * 50 + 100],
        ],
        source: { marker: "none", boundId: s, connection: [0.5, 0] },
        target: { marker: "arrow", boundId: t, connection: [0.5, 1] },
        texts: [],
        strokeWidth: 2,
      });
      vi.mocked(parseMermaidToDrawnix).mockResolvedValue({
        elements: [
          {
            id: "nodeA",
            type: "geometry",
            points: [
              [10, 10],
              [110, 50],
            ],
          },
          {
            id: "nodeB",
            type: "geometry",
            points: [
              [200, 100],
              [320, 150],
            ],
          },
          {
            id: "nodeC",
            type: "geometry",
            points: [
              [30, 120],
              [100, 160],
            ],
          },
          {
            id: "nodeD",
            type: "geometry",
            points: [
              [150, 250],
              [290, 300],
            ],
          },
          mkLine("l1", "nodeA", "nodeB"),
          mkLine("l2", "nodeA", "nodeC"),
          mkLine("l3", "nodeB", "nodeD"),
          mkLine("l4", "nodeC", "nodeD"),
        ],
      } as never);
      fakeCaller.canvases.createCanvas.mockResolvedValue({
        id: "canvas-1",
        title: "测试画布",
      });

      const tool = await getCreateCanvasTool();
      await tool.execute({
        description: "分支流程",
        mermaid: "graph TD; A-->B; A-->C; B-->D; C-->D",
      });

      const data = fakeCaller.canvases.createCanvas.mock.calls[0]![0].data as {
        id: string;
        type: string;
        points: number[][];
      }[];
      const byId = new Map(data.map((e) => [e.id, e]));
      const node = (id: string) => byId.get(id)!.points;

      // 统一尺寸（W=max(140,节点宽)=140，H=max(60,节点高)=60）
      for (const id of ["nodeA", "nodeB", "nodeC", "nodeD"]) {
        const [[x1, y1], [x2, y2]] = node(id);
        expect(x2 - x1).toBe(140);
        expect(y2 - y1).toBe(60);
      }
      // 同层（B、C）y 对齐、等距、对称
      expect(node("nodeB")[0][1]).toBe(node("nodeC")[0][1]);
      expect(node("nodeA")[0][1]).toBe(0);
      expect(node("nodeD")[0][1]).toBe(2 * (60 + 80));
      expect(node("nodeC")[0][0]).toBe(-110); // 层内按原 x 从左到右
      expect(node("nodeB")[0][0]).toBe(110);
      expect(node("nodeA")[0][0]).toBe(0); // 单节点层居中于 0

      // 所有连线相邻段轴向（横平竖直）
      for (const l of ["l1", "l2", "l3", "l4"]) {
        const pts = byId.get(l)!.points;
        for (let i = 1; i < pts.length; i++) {
          const dx = Math.abs(pts[i]![0] - pts[i - 1]![0]);
          const dy = Math.abs(pts[i]![1] - pts[i - 1]![1]);
          expect(dx === 0 || dy === 0).toBe(true);
        }
      }
      // 正向跨层线锚点：源底中 / 目标顶中
      const l1 = data.find((e) => e.id === "l1") as unknown as {
        source: { connection: number[] };
        target: { connection: number[] };
      };
      expect(l1.source.connection).toEqual([0.5, 1]);
      expect(l1.target.connection).toEqual([0.5, 0]);
    },
  );

  it(
    "flowchart 整齐化重排：subgraph 分组图同组成员相邻",
    { timeout: 60_000 },
    async () => {
      // 分支图 A→{B,C,U}，B→D；B、C 同属组 g1，U 无组。
      // 组成员虽被 U 按元素顺序隔开，重排后同层内应聚拢相邻
      const mkLine = (id: string, s: string, t: string) => ({
        id,
        type: "arrow-line",
        points: [
          [Math.random() * 50, Math.random() * 50],
          [Math.random() * 50 + 100, Math.random() * 50 + 100],
        ],
        source: { marker: "none", boundId: s, connection: [0.5, 0] },
        target: { marker: "arrow", boundId: t, connection: [0.5, 1] },
        texts: [],
        strokeWidth: 2,
      });
      vi.mocked(parseMermaidToDrawnix).mockResolvedValue({
        elements: [
          {
            id: "nodeA",
            type: "geometry",
            points: [
              [10, 10],
              [110, 50],
            ],
          },
          {
            id: "nodeB",
            type: "geometry",
            groupId: "g1",
            points: [
              [200, 100],
              [320, 150],
            ],
          },
          {
            id: "nodeC",
            type: "geometry",
            groupId: "g1",
            points: [
              [30, 120],
              [100, 160],
            ],
          },
          {
            id: "nodeU",
            type: "geometry",
            points: [
              [120, 110],
              [180, 150],
            ],
          },
          {
            id: "nodeD",
            type: "geometry",
            points: [
              [150, 250],
              [290, 300],
            ],
          },
          { id: "g1", type: "group" },
          mkLine("l1", "nodeA", "nodeB"),
          mkLine("l2", "nodeA", "nodeC"),
          mkLine("l3", "nodeA", "nodeU"),
          mkLine("l4", "nodeB", "nodeD"),
        ],
      } as never);
      fakeCaller.canvases.createCanvas.mockResolvedValue({
        id: "canvas-1",
        title: "测试画布",
      });

      const tool = await getCreateCanvasTool();
      await tool.execute({
        description: "分组流程",
        mermaid: "graph TD; A-->B; A-->C; A-->U; B-->D",
      });

      const data = fakeCaller.canvases.createCanvas.mock.calls[0]![0].data as {
        id: string;
        type: string;
        points: number[][];
        groupId?: string;
      }[];
      const byId = new Map(data.map((e) => [e.id, e]));
      const node = (id: string) => byId.get(id)!.points;

      // 统一尺寸 + 同层（B、C、U）y 对齐
      for (const id of ["nodeA", "nodeB", "nodeC", "nodeU", "nodeD"]) {
        const [[x1, y1], [x2, y2]] = node(id);
        expect(x2 - x1).toBe(140);
        expect(y2 - y1).toBe(60);
      }
      expect(node("nodeB")[0][1]).toBe(node("nodeC")[0][1]);
      expect(node("nodeB")[0][1]).toBe(node("nodeU")[0][1]);

      // 组 g1 中心 x=(260+65)/2=162.5 > U 原 x=120 → 层内顺序 [U, C, B]
      expect(node("nodeU")[0][0]).toBe(-220);
      expect(node("nodeC")[0][0]).toBe(0);
      expect(node("nodeB")[0][0]).toBe(220);
      // 同组成员相邻（间距恰为 W+GAP）
      expect(node("nodeB")[0][0] - node("nodeC")[0][0]).toBe(220);

      // 组壳原样保留、成员 groupId 不丢
      expect(byId.get("g1")).toEqual({ id: "g1", type: "group" });
      expect(byId.get("nodeB")!.groupId).toBe("g1");
      expect(byId.get("nodeC")!.groupId).toBe("g1");

      // 所有连线轴向
      for (const l of ["l1", "l2", "l3", "l4"]) {
        const pts = byId.get(l)!.points;
        for (let i = 1; i < pts.length; i++) {
          const dx = Math.abs(pts[i]![0] - pts[i - 1]![0]);
          const dy = Math.abs(pts[i]![1] - pts[i - 1]![1]);
          expect(dx === 0 || dy === 0).toBe(true);
        }
      }
    },
  );

  it(
    "flowchart 整齐化重排：回边（重试环）不推高层级",
    { timeout: 60_000 },
    async () => {
      // A→B→C→{D,E}，E→B 回边成环；环上节点层级应收敛（B=1,C=2,E=3）
      const mkLine = (id: string, s: string, t: string) => ({
        id,
        type: "arrow-line",
        points: [
          [Math.random() * 50, Math.random() * 50],
          [Math.random() * 50 + 100, Math.random() * 50 + 100],
        ],
        source: { marker: "none", boundId: s, connection: [0.5, 0] },
        target: { marker: "arrow", boundId: t, connection: [0.5, 1] },
        texts: [],
        strokeWidth: 2,
      });
      const geo = (id: string, x: number, y: number) => ({
        id,
        type: "geometry",
        points: [
          [x, y],
          [x + 100, y + 40],
        ],
      });
      vi.mocked(parseMermaidToDrawnix).mockResolvedValue({
        elements: [
          geo("nodeA", 10, 10),
          geo("nodeB", 200, 100),
          geo("nodeC", 400, 200),
          geo("nodeD", 600, 300),
          geo("nodeE", 100, 300),
          mkLine("l1", "nodeA", "nodeB"),
          mkLine("l2", "nodeB", "nodeC"),
          mkLine("l3", "nodeC", "nodeD"),
          mkLine("l4", "nodeC", "nodeE"),
          mkLine("l5", "nodeE", "nodeB"), // 回边
        ],
      } as never);
      fakeCaller.canvases.createCanvas.mockResolvedValue({
        id: "canvas-1",
        title: "测试画布",
      });

      const tool = await getCreateCanvasTool();
      await tool.execute({
        description: "重试环",
        mermaid: "graph TD; A-->B; B-->C; C-->D; C-->E; E-->B",
      });

      const data = fakeCaller.canvases.createCanvas.mock.calls[0]![0].data as {
        id: string;
        type: string;
        points: number[][];
      }[];
      const byId = new Map(data.map((e) => [e.id, e]));
      const yOf = (id: string) => byId.get(id)!.points[0]![1];

      // 层级收敛：A=0 B=1 C=2 D=E=3（H+GAP=140）
      expect(yOf("nodeA")).toBe(0);
      expect(yOf("nodeB")).toBe(140);
      expect(yOf("nodeC")).toBe(280);
      expect(yOf("nodeD")).toBe(420);
      expect(yOf("nodeE")).toBe(420);

      // 回边 E→B 走右侧绕行，仍轴向
      const pts = byId.get("l5")!.points;
      for (let i = 1; i < pts.length; i++) {
        const dx = Math.abs(pts[i]![0] - pts[i - 1]![0]);
        const dy = Math.abs(pts[i]![1] - pts[i - 1]![1]);
        expect(dx === 0 || dy === 0).toBe(true);
      }
    },
  );

  it("非法 mermaid 语法 → 返回转换失败错误", { timeout: 60_000 }, async () => {
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
  });
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
    // bm1、bm2 同行左右相邻 → 相向边锚点：源右边中点 → 目标左边中点
    expect(line).toEqual({
      id: "link-0",
      type: "arrow-line",
      shape: "straight",
      source: { marker: "none", boundId: "card-bm1", connection: [1, 0.5] },
      target: { marker: "arrow", boundId: "card-bm2", connection: [0, 0.5] },
      texts: [],
      strokeWidth: 2,
      points: [
        [256, 44],
        [336, 44],
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

  it("上下相邻卡连线 → 源底边中点 → 目标顶边中点（不再纵穿卡片）", () => {
    const bookmarks = ["a", "b", "c", "d"].map((id) => ({
      id,
      title: `t-${id}`,
      url: `https://x.com/${id}`,
      favicon: null,
    }));
    // a 在 (0,0)，d 在 (0,168)：同一列的上下关系
    const elements = buildBookmarkCanvasElements(bookmarks, [
      { source: "a", target: "d" },
    ]);
    const line = elements.find((e) => e.type === "arrow-line");
    if (!line) throw new Error("未生成连线");

    expect(line.source.connection).toEqual([0.5, 1]);
    expect(line.target.connection).toEqual([0.5, 0]);
    expect(line.points).toEqual([
      [128, 88],
      [128, 168],
    ]);
  });
});

// ── Widget 工具 ──────────────────────────────────────────

async function getWidgetTool(name: string) {
  const tools = await buildAgentTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

describe("save_widget", () => {
  it("调用 widgets.save 并组装 manifest（apiVersion 固定为 1）", async () => {
    fakeCaller.widgets.save.mockResolvedValue({ id: "w-1", version: 1 });

    const tool = await getWidgetTool("save_widget");
    const raw = await tool.execute({
      name: "本周书签统计",
      size: "md",
      permissions: ["bookmarks:read"],
      code: '<div id="root"></div><script>/* ... */</script>',
    });
    const result = JSON.parse(raw);

    expect(fakeCaller.widgets.save).toHaveBeenCalledWith({
      name: "本周书签统计",
      description: undefined,
      manifest: {
        apiVersion: 1,
        size: "md",
        permissions: ["bookmarks:read"],
      },
      code: '<div id="root"></div><script>/* ... */</script>',
    });
    expect(result.widgetId).toBe("w-1");
    expect(result.version).toBe(1);
    expect(result.message).toContain("安装");
  });

  it("声明 v1 写权限时透传到 manifest（W4 回归）", async () => {
    fakeCaller.widgets.save.mockResolvedValue({ id: "w-2", version: 1 });

    const tool = await getWidgetTool("save_widget");
    const raw = await tool.execute({
      name: "快速保存",
      permissions: ["bookmarks:read", "bookmarks:write"],
      code: '<div id="root"></div><script>/* ... */</script>',
    });
    JSON.parse(raw);

    const call = fakeCaller.widgets.save.mock.calls[0][0];
    expect(call.manifest.permissions).toEqual([
      "bookmarks:read",
      "bookmarks:write",
    ]);
  });

  it("调用失败（如 lint 拒绝）时错误向上抛出", async () => {
    fakeCaller.widgets.save.mockRejectedValue(
      new Error("Widget code lint failed: 禁止使用外部资源"),
    );

    const tool = await getWidgetTool("save_widget");
    await expect(() =>
      tool.execute({
        name: "坏组件",
        size: "md",
        permissions: [],
        code: '<script src="https://evil.com/x.js"></script>',
      }),
    ).rejects.toThrow(/lint failed/);
  });
});

describe("update_widget", () => {
  it("传 code → 更新内容，未扩权时提示自动生效", async () => {
    fakeCaller.widgets.update.mockResolvedValue({
      id: "w-1",
      version: 2,
      reInstallRequired: false,
    });

    const tool = await getWidgetTool("update_widget");
    const raw = await tool.execute({ widgetId: "w-1", code: "<div></div>" });
    const result = JSON.parse(raw);

    expect(fakeCaller.widgets.update).toHaveBeenCalledWith({
      widgetId: "w-1",
      code: "<div></div>",
    });
    expect(result.version).toBe(2);
    expect(result.reInstallRequired).toBe(false);
  });

  it("传 size/permissions → 组装部分 manifest；扩权时提示需重装", async () => {
    fakeCaller.widgets.update.mockResolvedValue({
      id: "w-1",
      version: 3,
      reInstallRequired: true,
    });

    const tool = await getWidgetTool("update_widget");
    const raw = await tool.execute({
      widgetId: "w-1",
      code: "<div></div>",
      permissions: ["bookmarks:read", "tags:read"],
    });
    const result = JSON.parse(raw);

    const call = fakeCaller.widgets.update.mock.calls[0][0];
    expect(call.manifest).toEqual({
      apiVersion: 1,
      permissions: ["bookmarks:read", "tags:read"],
    });
    expect(call.manifest.size).toBeUndefined();
    expect(result.reInstallRequired).toBe(true);
  });

  it("只改名称 → 不传 manifest", async () => {
    fakeCaller.widgets.update.mockResolvedValue({
      id: "w-1",
      version: 2,
      reInstallRequired: false,
    });

    const tool = await getWidgetTool("update_widget");
    await tool.execute({ widgetId: "w-1", name: "新名字" });

    const call = fakeCaller.widgets.update.mock.calls[0][0];
    expect(call.manifest).toBeUndefined();
    expect(call.name).toBe("新名字");
  });
});

describe("list_widgets", () => {
  it("返回 widgetId/name/status/version 摘要", async () => {
    fakeCaller.widgets.list.mockResolvedValue([
      {
        id: "w-1",
        name: "统计卡",
        status: "enabled",
        currentVersion: 3,
        description: "本周书签",
      },
    ]);

    const tool = await getWidgetTool("list_widgets");
    const raw = await tool.execute({});
    const result = JSON.parse(raw);

    expect(result).toEqual([
      {
        widgetId: "w-1",
        name: "统计卡",
        status: "enabled",
        version: 3,
        description: "本周书签",
      },
    ]);
  });
});

describe("delete_widget", () => {
  it("调用 widgets.delete 并返回 success", async () => {
    fakeCaller.widgets.delete.mockResolvedValue({ success: true });

    const tool = await getWidgetTool("delete_widget");
    const raw = await tool.execute({ widgetId: "w-1" });
    const result = JSON.parse(raw);

    expect(fakeCaller.widgets.delete).toHaveBeenCalledWith({
      widgetId: "w-1",
    });
    expect(result.success).toBe(true);
  });
});

describe("rollback_widget", () => {
  it("不传 version → 默认回滚上一版", async () => {
    fakeCaller.widgets.rollback.mockResolvedValue({
      version: 4,
      rolledBackFrom: 2,
      reInstallRequired: false,
    });

    const tool = await getWidgetTool("rollback_widget");
    const raw = await tool.execute({ widgetId: "w-1" });
    const result = JSON.parse(raw);

    expect(fakeCaller.widgets.rollback).toHaveBeenCalledWith({
      widgetId: "w-1",
    });
    expect(result.newVersion).toBe(4);
    expect(result.rolledBackFrom).toBe(2);
  });

  it("传 version → 回滚到指定版本", async () => {
    fakeCaller.widgets.rollback.mockResolvedValue({
      version: 5,
      rolledBackFrom: 1,
      reInstallRequired: false,
    });

    const tool = await getWidgetTool("rollback_widget");
    await tool.execute({ widgetId: "w-1", version: 1 });

    expect(fakeCaller.widgets.rollback).toHaveBeenCalledWith({
      widgetId: "w-1",
      version: 1,
    });
  });
});

// ── 用户设置工具 ─────────────────────────────────────────

async function getSettingsTool(name: string) {
  const tools = await buildAgentTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

describe("get_user_settings", () => {
  it("返回 users.settings 的完整设置", async () => {
    const settings = {
      bookmarkClickAction: "open_original_link",
      archiveDisplayBehaviour: "show",
      timezone: "UTC",
      backupsEnabled: false,
      backupsFrequency: "weekly",
      backupsRetentionDays: 30,
      readerFontSize: null,
      readerLineHeight: null,
      readerFontFamily: null,
      autoTaggingEnabled: null,
      autoSummarizationEnabled: null,
      chatKnowledgeContextEnabled: null,
      tagStyle: "as-generated",
      curatedTagIds: null,
      inferredTagLang: null,
    };
    fakeCaller.users.settings.mockResolvedValue(settings);

    const tool = await getSettingsTool("get_user_settings");
    const raw = await tool.execute({});
    expect(JSON.parse(raw)).toEqual(settings);
  });
});

describe("update_user_settings", () => {
  it("部分字段更新 → 调 updateSettings 并返回变更前后对比", async () => {
    fakeCaller.users.settings.mockResolvedValue({
      timezone: "UTC",
      autoTaggingEnabled: false,
    });
    fakeCaller.users.updateSettings.mockResolvedValue(undefined);

    const tool = await getSettingsTool("update_user_settings");
    const raw = await tool.execute({ timezone: "Asia/Shanghai" });
    const result = JSON.parse(raw);

    expect(fakeCaller.users.updateSettings).toHaveBeenCalledWith({
      timezone: "Asia/Shanghai",
    });
    expect(result).toEqual({
      success: true,
      changed: [{ key: "timezone", before: "UTC", after: "Asia/Shanghai" }],
    });
  });

  it("空参数 → 返回错误，不调用 updateSettings", async () => {
    const tool = await getSettingsTool("update_user_settings");
    const raw = await tool.execute({});
    const result = JSON.parse(raw);

    expect(result.error).toContain("至少提供");
    expect(fakeCaller.users.updateSettings).not.toHaveBeenCalled();
  });

  it("只传 localSettings → 不写 DB，结果回显 localSettings", async () => {
    const tool = await getSettingsTool("update_user_settings");
    const raw = await tool.execute({ localSettings: { lang: "zh" } });
    const result = JSON.parse(raw);

    expect(fakeCaller.users.settings).not.toHaveBeenCalled();
    expect(fakeCaller.users.updateSettings).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      localSettings: { lang: "zh" },
    });
  });

  it("localSettings 混合 DB 字段 → 剥离后写库，两者都回显", async () => {
    fakeCaller.users.settings.mockResolvedValue({ timezone: "UTC" });
    fakeCaller.users.updateSettings.mockResolvedValue(undefined);

    const tool = await getSettingsTool("update_user_settings");
    const raw = await tool.execute({
      timezone: "Asia/Shanghai",
      localSettings: { lang: "zh", gridColumns: 5 },
    });
    const result = JSON.parse(raw);

    expect(fakeCaller.users.updateSettings).toHaveBeenCalledWith({
      timezone: "Asia/Shanghai",
    });
    expect(result).toEqual({
      success: true,
      changed: [{ key: "timezone", before: "UTC", after: "Asia/Shanghai" }],
      localSettings: { lang: "zh", gridColumns: 5 },
    });
  });

  it("curatedTagIds 已开放 → 作为 DB 字段写库", async () => {
    fakeCaller.users.settings.mockResolvedValue({ curatedTagIds: null });
    fakeCaller.users.updateSettings.mockResolvedValue(undefined);

    const tool = await getSettingsTool("update_user_settings");
    const raw = await tool.execute({ curatedTagIds: ["tag-1", "tag-2"] });
    const result = JSON.parse(raw);

    expect(fakeCaller.users.updateSettings).toHaveBeenCalledWith({
      curatedTagIds: ["tag-1", "tag-2"],
    });
    expect(result.changed).toEqual([
      { key: "curatedTagIds", before: null, after: ["tag-1", "tag-2"] },
    ]);
  });
});

// ── RSS 订阅工具 ─────────────────────────────────────────

async function getFeedTool(name: string) {
  const tools = await buildAgentTools(ctx);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

describe("subscribe_feed", () => {
  it("创建订阅并立即触发首次拉取", async () => {
    fakeCaller.feeds.create.mockResolvedValue({
      id: "feed-1",
      name: "某作者的博客",
      url: "https://example.com/feed.xml",
      enabled: true,
      importTags: false,
      lastFetchedStatus: "pending",
      lastFetchedAt: null,
      lastSuccessfulFetchAt: null,
    });
    fakeCaller.feeds.fetchNow.mockResolvedValue(undefined);

    const tool = await getFeedTool("subscribe_feed");
    const raw = await tool.execute({
      name: "某作者的博客",
      url: "https://example.com/feed.xml",
    });
    const result = JSON.parse(raw);

    expect(fakeCaller.feeds.create).toHaveBeenCalledWith({
      name: "某作者的博客",
      url: "https://example.com/feed.xml",
      enabled: true,
      importTags: false,
    });
    expect(fakeCaller.feeds.fetchNow).toHaveBeenCalledWith({
      feedId: "feed-1",
    });
    expect(result).toEqual({
      success: true,
      feedId: "feed-1",
      name: "某作者的博客",
      url: "https://example.com/feed.xml",
      enabled: true,
      firstFetchTriggered: true,
    });
  });

  it("创建失败 → 返回 error，不触发拉取", async () => {
    fakeCaller.feeds.create.mockRejectedValue(new Error("invalid feed url"));

    const tool = await getFeedTool("subscribe_feed");
    const raw = await tool.execute({
      name: "x",
      url: "https://example.com/feed.xml",
    });
    const result = JSON.parse(raw);

    expect(result.error).toContain("订阅失败");
    expect(fakeCaller.feeds.fetchNow).not.toHaveBeenCalled();
  });
});

describe("list_feeds / unsubscribe_feed", () => {
  it("list_feeds 返回完整订阅列表", async () => {
    fakeCaller.feeds.list.mockResolvedValue({
      feeds: [
        { id: "feed-1", name: "A", url: "https://a.com/rss", enabled: true },
      ],
    });

    const tool = await getFeedTool("list_feeds");
    const raw = await tool.execute({});
    expect(JSON.parse(raw).feeds).toHaveLength(1);
  });

  it("unsubscribe_feed 按 feedId 删除", async () => {
    fakeCaller.feeds.delete.mockResolvedValue(undefined);

    const tool = await getFeedTool("unsubscribe_feed");
    const raw = await tool.execute({ feedId: "feed-1" });

    expect(fakeCaller.feeds.delete).toHaveBeenCalledWith({ feedId: "feed-1" });
    expect(JSON.parse(raw)).toEqual({ success: true, feedId: "feed-1" });
  });
});
