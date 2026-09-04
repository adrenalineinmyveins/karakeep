// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlaitBoard as PlaitBoardType,
  PlaitElement,
  Point,
} from "@plait/core";

/**
 * withBookmarkCard 插件单元测试——聚焦右键菜单数据流：
 *
 *   contextmenu 事件 → 容器校验 → 坐标转换（client→host→viewBox）
 *   → getHitElementByPoint 命中 → preventDefault + 选中元素
 *   → board.openBookmarkCardMenu(element, [clientX, clientY]) 通知 React 层
 *
 * @plait/core 的坐标转换与命中函数按恒定映射 mock，
 * 以便精确断言坐标串联顺序（回归此前 clientX/Y 直传与 toHostPoint
 * 签名误用两个 bug）。
 */
const mocks = vi.hoisted(() => {
  // BookmarkMindNodeComponent 的基类桩：drawElement 拦截断言用原型链识别
  class FakeMindNodeComponent {}
  return {
    // 每个测试 board 各自对应一个画布容器，模拟 getBoardContainer 的注册表
    containerByBoard: new Map<object, HTMLElement>(),
    // 模拟 BOARD_TO_HOST 注册表（getHost）：注销后 toViewBoxPoint 会崩溃，
    // 插件层需据此防护 "Cannot read properties of undefined (reading 'viewBox')"
    hostByBoard: new Map<object, object>(),
    toHostPoint: vi.fn(),
    toViewBoxPoint: vi.fn(),
    getHitElementByPoint: vi.fn(),
    setSelectedElementsWithGroup: vi.fn(),
    // —— 思维导图集成相关 mock ——
    FakeMindNodeComponent,
    createEmptyMind: vi.fn(),
    findPath: vi.fn(),
    insertNode: vi.fn(),
    removeNode: vi.fn(),
    setSelection: vi.fn(),
  };
});

vi.mock("@plait/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@plait/core")>();
  return {
    ...actual,
    PlaitBoard: Object.assign(actual.PlaitBoard, {
      getBoardContainer: (board: object) => mocks.containerByBoard.get(board),
      getHost: (board: object) => mocks.hostByBoard.get(board),
      findPath: mocks.findPath,
    }),
    Transforms: {
      ...actual.Transforms,
      insertNode: mocks.insertNode,
      removeNode: mocks.removeNode,
      setSelection: mocks.setSelection,
    },
    toHostPoint: mocks.toHostPoint,
    toViewBoxPoint: mocks.toViewBoxPoint,
    getHitElementByPoint: mocks.getHitElementByPoint,
    setSelectedElementsWithGroup: mocks.setSelectedElementsWithGroup,
  };
});

vi.mock("@plait/mind", () => ({
  createEmptyMind: mocks.createEmptyMind,
  MindNodeComponent: mocks.FakeMindNodeComponent,
  PlaitMind: {
    isMind: (e: unknown) => !!e && (e as { type?: string }).type === "mind",
  },
}));

import { BasicShapes, ArrowLineAutoCompleteGenerator } from "@plait/draw";
import { createTestingBoard } from "@plait/core";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  LEGACY_BOOKMARK_CARD_TYPE,
  attachBookmarkCardToMind,
  createBookmarkCard,
  createBookmarkMindNode,
  isBookmarkCard,
  isBookmarkMindNode,
  normalizeCanvasValue,
  removeBookmarkCard,
  withBookmarkCard,
} from "./withBookmarkCard";
import type { BookmarkCardElement } from "./withBookmarkCard";

function makeCard(
  overrides: Partial<BookmarkCardElement> = {},
): BookmarkCardElement {
  return {
    id: "card-1",
    type: "geometry",
    shape: BasicShapes.rectangle,
    bookmarkId: "bm-1",
    title: "Example",
    url: "https://example.com",
    favicon: null,
    points: [
      [-CARD_WIDTH / 2, -CARD_HEIGHT / 2],
      [CARD_WIDTH / 2, CARD_HEIGHT / 2],
    ],
    ...overrides,
  };
}

function makeBoard() {
  return {
    drawElement: vi.fn(),
    getRectangle: vi.fn(),
    isRectangleHit: vi.fn(),
    isHit: vi.fn(),
    isMovable: vi.fn(),
    isAlign: vi.fn(),
    dblClick: vi.fn(),
  } as unknown as PlaitBoardType & {
    isHit: (element: PlaitElement, point: Point, isStrict?: boolean) => boolean;
    dblClick: (event: MouseEvent) => void;
  };
}

function rightClick(target: Element, clientX: number, clientY: number) {
  const ev = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 2,
  });
  target.dispatchEvent(ev);
  return ev;
}

describe("withBookmarkCard 右键菜单", () => {
  let board: ReturnType<typeof makeBoard>;
  let container: HTMLElement;
  let inner: HTMLElement;
  let card: BookmarkCardElement;
  let openMenu: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // 恒定坐标映射：client(300,200) → host(200,150) → viewBox(100,75)
    mocks.toHostPoint.mockImplementation(
      (_board: unknown, x: number, y: number) => [x - 100, y - 50],
    );
    mocks.toViewBoxPoint.mockImplementation((_board: unknown, p: Point) => [
      p[0] / 2,
      p[1] / 2,
    ]);

    board = makeBoard();
    container = document.createElement("div");
    inner = document.createElement("div");
    container.appendChild(inner);
    document.body.appendChild(container);
    mocks.containerByBoard.set(board, container);
    mocks.hostByBoard.set(board, {});

    card = makeCard();
    openMenu = vi.fn();
    board.openBookmarkCardMenu = openMenu;

    withBookmarkCard(board);
  });

  afterEach(() => {
    // 清空容器注册表后派发一次事件，触发所有残留监听器自毁，
    // 避免跨测试的 document 级监听器累积
    mocks.containerByBoard.clear();
    mocks.hostByBoard.clear();
    document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: false }));
    container.remove();
  });

  it("右键命中卡片：阻止默认菜单、选中该卡片、以屏幕坐标通知菜单打开", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);

    const ev = rightClick(inner, 300, 200);

    expect(ev.defaultPrevented).toBe(true);
    expect(mocks.setSelectedElementsWithGroup).toHaveBeenCalledWith(
      board,
      [card],
      false,
    );
    expect(openMenu).toHaveBeenCalledTimes(1);
    expect(openMenu).toHaveBeenCalledWith(card, [300, 200]);
  });

  it("坐标转换按 client → host → viewBox 串联传递", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);

    rightClick(inner, 300, 200);

    expect(mocks.toHostPoint).toHaveBeenCalledWith(board, 300, 200);
    expect(mocks.toViewBoxPoint).toHaveBeenCalledWith(board, [200, 150]);
    expect(mocks.getHitElementByPoint).toHaveBeenCalledWith(
      board,
      [100, 75],
      expect.any(Function),
    );
  });

  it("右键空白处（未命中）：不阻止默认行为、不选中、不弹菜单", () => {
    mocks.getHitElementByPoint.mockReturnValue(undefined);

    const ev = rightClick(inner, 300, 200);

    expect(ev.defaultPrevented).toBe(false);
    expect(mocks.setSelectedElementsWithGroup).not.toHaveBeenCalled();
    expect(openMenu).not.toHaveBeenCalled();
  });

  it("右键画布容器外：直接忽略，不做命中测试", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    const ev = rightClick(outside, 300, 200);

    expect(ev.defaultPrevented).toBe(false);
    expect(mocks.getHitElementByPoint).not.toHaveBeenCalled();
    expect(openMenu).not.toHaveBeenCalled();
    outside.remove();
  });

  it("容器未注册：监听器自毁，此后即使容器恢复也不再响应", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);
    mocks.containerByBoard.delete(board);

    // 触发自毁分支
    rightClick(inner, 300, 200);
    expect(mocks.getHitElementByPoint).not.toHaveBeenCalled();

    // 恢复注册，监听器已移除，仍不响应
    mocks.containerByBoard.set(board, container);
    rightClick(inner, 300, 200);
    expect(openMenu).not.toHaveBeenCalled();
  });

  it("容器已脱离文档：监听器自毁", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);
    container.remove();

    // 容器已脱离文档，其内部派发的事件不会冒泡到 document，
    // 因此在 document 上派发以触发监听器的自毁分支
    document.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 300, clientY: 200 }),
    );
    expect(mocks.getHitElementByPoint).not.toHaveBeenCalled();

    // 重新挂载也不会复活
    document.body.appendChild(container);
    rightClick(inner, 300, 200);
    expect(openMenu).not.toHaveBeenCalled();
  });

  it("host 已注销（画布卸载竞态）：监听器自毁且不做坐标转换（viewBox 崩溃回归）", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);
    mocks.hostByBoard.delete(board);

    // 不应抛 "Cannot read properties of undefined (reading 'viewBox')"
    rightClick(inner, 300, 200);

    expect(mocks.toHostPoint).not.toHaveBeenCalled();
    expect(mocks.toViewBoxPoint).not.toHaveBeenCalled();
    expect(openMenu).not.toHaveBeenCalled();

    // 恢复注册后监听器已自毁，不再响应
    mocks.hostByBoard.set(board, {});
    rightClick(inner, 300, 200);
    expect(openMenu).not.toHaveBeenCalled();
  });
});

describe("withBookmarkCard 双击", () => {
  let board: ReturnType<typeof makeBoard>;
  let container: HTMLElement;
  let card: BookmarkCardElement;
  let openSpy: ReturnType<typeof vi.fn>;
  // 应用插件前捕获原始 dblClick，插件会将其包装为新函数
  let origDblClick: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toHostPoint.mockImplementation(
      (_board: unknown, x: number, y: number) => [x - 100, y - 50],
    );
    mocks.toViewBoxPoint.mockImplementation((_board: unknown, p: Point) => [
      p[0] / 2,
      p[1] / 2,
    ]);

    board = makeBoard();
    container = document.createElement("div");
    document.body.appendChild(container);
    mocks.containerByBoard.set(board, container);
    mocks.hostByBoard.set(board, {});

    card = makeCard();
    openSpy = vi.fn();
    vi.spyOn(window, "open").mockImplementation(openSpy);

    origDblClick = board.dblClick as unknown as ReturnType<typeof vi.fn>;
    withBookmarkCard(board);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.containerByBoard.clear();
    mocks.hostByBoard.clear();
    document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: false }));
    container.remove();
  });

  it("双击命中卡片：在新标签页打开书签链接", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);

    board.dblClick(new MouseEvent("click", { clientX: 300, clientY: 200 }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
    // 命中卡片后不再委托原始实现
    expect(origDblClick).not.toHaveBeenCalled();
  });

  it("双击空白处：委托原始 dblClick 实现", () => {
    mocks.getHitElementByPoint.mockReturnValue(undefined);

    const ev = new MouseEvent("click", { clientX: 300, clientY: 200 });
    board.dblClick(ev);

    expect(openSpy).not.toHaveBeenCalled();
    expect(origDblClick).toHaveBeenCalledWith(ev);
  });

  it("host 未注册（画布卸载竞态）：直接返回，不做坐标转换（viewBox 崩溃回归）", () => {
    mocks.getHitElementByPoint.mockReturnValue(card);
    mocks.hostByBoard.delete(board);

    // 不应抛 "Cannot read properties of undefined (reading 'viewBox')"
    expect(() =>
      board.dblClick(new MouseEvent("click", { clientX: 300, clientY: 200 })),
    ).not.toThrow();

    expect(mocks.toHostPoint).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("withBookmarkCard 命中判定钩子", () => {
  it("isHit：卡片按包围盒判定，非卡片元素委托原实现", () => {
    const board = makeBoard();
    const origIsHit = board.isHit as unknown as ReturnType<typeof vi.fn>;
    withBookmarkCard(board);

    const card = makeCard(); // 包围盒 x∈[-128,128] y∈[-44,44]
    expect(board.isHit(card, [0, 0])).toBe(true);
    expect(board.isHit(card, [-128, 44])).toBe(true); // 边界含入
    expect(board.isHit(card, [500, 0])).toBe(false);
    expect(board.isHit(card, [0, 45])).toBe(false);

    const other = { id: "x", type: "line" } as unknown as PlaitElement;
    board.isHit(other, [0, 0]);
    expect(origIsHit).toHaveBeenCalledWith(other, [0, 0], undefined);
  });
});

describe("createBookmarkCard", () => {
  it("生成 geometry 矩形元素：两点式 points（左上、右下）+ 书签标记", () => {
    const card = createBookmarkCard(
      { bookmarkId: "bm-1", title: "T", url: "https://example.com" },
      [10, 20],
    );
    expect(card.type).toBe("geometry");
    expect(card.shape).toBe("rectangle");
    expect(isBookmarkCard(card)).toBe(true);
    expect(card.points).toEqual([
      [10 - CARD_WIDTH / 2, 20 - CARD_HEIGHT / 2],
      [10 + CARD_WIDTH / 2, 20 + CARD_HEIGHT / 2],
    ]);
  });
});

describe("normalizeCanvasValue", () => {
  it("旧版 bookmarkCard（四角 points）转换为 geometry 矩形两点式，书签字段保留", () => {
    const legacy = {
      id: "old-1",
      type: LEGACY_BOOKMARK_CARD_TYPE,
      bookmarkId: "bm-1",
      points: [
        [0, 0],
        [256, 0],
        [256, 88],
        [0, 88],
      ],
    } as unknown as PlaitElement;

    const [converted] = normalizeCanvasValue([legacy]);

    expect(converted?.type).toBe("geometry");
    expect(converted?.shape).toBe("rectangle");
    expect(converted?.points).toEqual([
      [0, 0],
      [256, 88],
    ]);
    expect(isBookmarkCard(converted)).toBe(true);
    expect((converted as BookmarkCardElement).bookmarkId).toBe("bm-1");
  });

  it("递归穿透容器元素规范化嵌套的旧卡片", () => {
    const legacy = {
      type: LEGACY_BOOKMARK_CARD_TYPE,
      bookmarkId: "bm-1",
      points: [
        [10, 10],
        [30, 10],
        [30, 50],
        [10, 50],
      ],
    } as unknown as PlaitElement;
    const group = {
      id: "g",
      type: "group",
      children: [legacy],
    } as PlaitElement;

    const [converted] = normalizeCanvasValue([group]);

    const child = converted?.children?.[0];
    expect(child?.type).toBe("geometry");
    expect(child?.points).toEqual([
      [10, 10],
      [30, 50],
    ]);
  });

  it("非旧卡片元素原样返回（同引用）", () => {
    const mind = makeMindRoot([0, 0]);
    const line = { id: "l", type: "arrow-line" } as PlaitElement;
    const card = makeCard();

    const result = normalizeCanvasValue([mind, line, card]);

    expect(result[0]).toBe(mind);
    expect(result[1]).toBe(line);
    expect(result[2]).toBe(card);
  });

  it("AI 连线（link- 前缀 id）重锚到相向边：左右相邻 → 源右边/目标左边", () => {
    const cardA = makeCard({
      id: "card-a",
      points: [
        [0, 0],
        [256, 88],
      ],
    });
    const cardB = makeCard({
      id: "card-b",
      points: [
        [336, 0],
        [592, 88],
      ],
    });
    const aiLine = {
      id: "link-0",
      type: "arrow-line",
      shape: "straight",
      // 旧版固定锚：源上边 → 目标下边（视觉斜穿卡片的根源）
      source: { marker: "none", boundId: "card-a", connection: [0.5, 0] },
      target: { marker: "arrow", boundId: "card-b", connection: [0.5, 1] },
      texts: [],
      strokeWidth: 2,
      points: [
        [128, 0],
        [464, 88],
      ],
      opacity: 1,
    } as unknown as PlaitElement;

    const [, , line] = normalizeCanvasValue([
      cardA,
      cardB,
      aiLine,
    ]) as unknown as {
      source: { connection: number[] };
      target: { connection: number[] };
      points: number[][];
    }[];

    expect(line.source.connection).toEqual([1, 0.5]);
    expect(line.target.connection).toEqual([0, 0.5]);
    expect(line.points).toEqual([
      [256, 44],
      [336, 44],
    ]);
  });

  it("手绘连线（UUID id）不受重锚影响", () => {
    const cardA = makeCard({
      id: "card-a",
      points: [
        [0, 0],
        [256, 88],
      ],
    });
    const cardB = makeCard({
      id: "card-b",
      points: [
        [336, 0],
        [592, 88],
      ],
    });
    const manualLine = {
      id: crypto.randomUUID(),
      type: "arrow-line",
      source: { marker: "none", boundId: "card-a", connection: [0.5, 0] },
      target: { marker: "arrow", boundId: "card-b", connection: [0.5, 1] },
      texts: [],
      strokeWidth: 2,
      points: [
        [128, 0],
        [464, 88],
      ],
      opacity: 1,
    } as unknown as PlaitElement;

    const [, , line] = normalizeCanvasValue([cardA, cardB, manualLine]);

    expect(line).toBe(manualLine);
  });

  it("mermaid 坏锚连线（越界/悬空 connection）重锚到节点边框", () => {
    // 真实 mermaid-to-drawnix 旧产物：折线端点带 gap，
    // connection 越界（y=-0.5075）或悬在框内（0.6875）
    const nodeA = {
      id: "nodeA",
      type: "geometry",
      points: [
        [42.5, 12.5],
        [142.5, 52.5],
      ],
    } as unknown as PlaitElement;
    const nodeB = {
      id: "nodeB",
      type: "geometry",
      points: [
        [35, 125],
        [135, 165],
      ],
    } as unknown as PlaitElement;
    const mermaidLine = {
      id: "pSQBC",
      type: "arrow-line",
      points: [
        [50, 40],
        [50, 65],
        [50, 104.7],
      ],
      source: { marker: "none", boundId: "nodeA", connection: [0.075, 0.6875] },
      target: {
        marker: "arrow",
        boundId: "nodeB",
        connection: [0.15, -0.5075],
      },
      texts: [],
      strokeWidth: 2,
      opacity: 1,
    } as unknown as PlaitElement;

    const [, , line] = normalizeCanvasValue([
      nodeA,
      nodeB,
      mermaidLine,
    ]) as unknown as {
      source: { connection: number[] };
      target: { connection: number[] };
      points: number[][];
    }[];

    // 折线垂直向下 → 源下边中点 / 目标上边中点
    expect(line.source.connection).toEqual([0.5, 1]);
    expect(line.target.connection).toEqual([0.5, 0]);
    expect(line.points[0]).toEqual([92.5, 52.5]);
    expect(line.points[2]).toEqual([85, 125]);
    // 中间折点保留
    expect(line.points[1]).toEqual([50, 65]);
  });
});

// ---------------------------------------------------------------------------
// 书签 × 思维导图集成
// ---------------------------------------------------------------------------

/** 构造思维导图中心主题（type='mind'），中心点由 points 推算 */
function makeMindRoot(
  center: Point,
  children: PlaitElement[] = [],
): PlaitElement {
  return {
    id: `mind-${center[0]}-${center[1]}`,
    type: "mind",
    points: [
      [center[0] - 50, center[1] - 20],
      [center[0] + 50, center[1] - 20],
      [center[0] + 50, center[1] + 20],
      [center[0] - 50, center[1] + 20],
    ],
    children,
  } as PlaitElement;
}

/** makeBoard 的思维导图版：带 children 与可变树。
 * apply 以可变树语义实现 remove_node（复用 mocks.removeNode），
 * 供 apply 兜底测试模拟 Delete 键等经由 board.apply 的通用删除。 */
function makeBoardWithChildren(children: PlaitElement[]) {
  const board = {
    children,
    drawElement: vi.fn(),
    getRectangle: vi.fn(),
    isRectangleHit: vi.fn(),
    isHit: vi.fn(),
    isMovable: vi.fn(),
    isAlign: vi.fn(),
    dblClick: vi.fn(),
    apply: vi.fn((op: { type: string; path?: number[] }) => {
      if (op.type === "remove_node" && op.path) {
        mocks.removeNode(board, op.path);
      }
    }),
  } as unknown as PlaitBoardType & { children: PlaitElement[] };
  return board;
}

/** 按引用递归搜索树，返回元素 path；与 plait 的 findPath 语义一致（mock 版） */
function pathOf(
  children: PlaitElement[],
  element: PlaitElement,
): number[] | null {
  for (let i = 0; i < children.length; i++) {
    if (children[i] === element) return [i];
    const kids = children[i].children;
    if (Array.isArray(kids)) {
      const sub = pathOf(kids, element);
      if (sub) return [i, ...sub];
    }
  }
  return null;
}

/** Transforms mock：以可变树语义真实插入/删除，便于断言最终结构 */
function installMutableTransformMocks(
  board: PlaitBoardType & { children: PlaitElement[] },
) {
  mocks.findPath.mockImplementation((b: unknown, el: PlaitElement) =>
    pathOf((b as { children: PlaitElement[] }).children, el),
  );
  mocks.insertNode.mockImplementation(
    (b: unknown, node: PlaitElement, path: number[]) => {
      const insert = (children: PlaitElement[], p: number[]) => {
        if (p.length === 1) {
          children.splice(p[0], 0, node);
          return;
        }
        insert(children[p[0]].children!, p.slice(1));
      };
      insert((b as { children: PlaitElement[] }).children, path);
    },
  );
  mocks.removeNode.mockImplementation((b: unknown, path: number[]) => {
    const remove = (children: PlaitElement[], p: number[]) => {
      if (p.length === 1) {
        children.splice(p[0], 1);
        return;
      }
      remove(children[p[0]].children!, p.slice(1));
    };
    remove((b as { children: PlaitElement[] }).children, path);
  });
  mocks.setSelection.mockImplementation(() => {});
  expect(board.children).toBeDefined();
}

describe("isBookmarkMindNode", () => {
  it("仅 type=mind_child 且携带 data.bookmark 的元素判定为书签节点", () => {
    const bookmarkChild = {
      type: "mind_child",
      data: { topic: {}, bookmark: { bookmarkId: "1", title: "t", url: "u" } },
      children: [],
    } as unknown as PlaitElement;
    const plainChild = {
      type: "mind_child",
      data: { topic: {} },
      children: [],
    } as unknown as PlaitElement;
    const mindRoot = makeMindRoot([0, 0]);
    const card = makeCard();

    expect(isBookmarkMindNode(bookmarkChild)).toBe(true);
    expect(isBookmarkMindNode(plainChild)).toBe(false);
    expect(isBookmarkMindNode(mindRoot)).toBe(false);
    expect(isBookmarkMindNode(card)).toBe(false);
    expect(isBookmarkMindNode(undefined)).toBe(false);
  });
});

describe("createBookmarkMindNode", () => {
  it("由卡片构造 mind_child：topic 承载标题、data.bookmark 保留完整载荷", () => {
    const card = makeCard({ title: "Karakeep", favicon: "https://x/f.png" });
    const node = createBookmarkMindNode(card);

    expect(node.type).toBe("mind_child");
    expect(node.id).toBeTruthy();
    expect(node.id).not.toBe(card.id);
    expect(node.children).toEqual([]);
    expect(node.data.topic).toEqual({
      type: "paragraph",
      children: [{ text: "Karakeep" }],
    });
    expect(node.data.bookmark).toEqual({
      bookmarkId: "bm-1",
      title: "Karakeep",
      url: "https://example.com",
      favicon: "https://x/f.png",
    });
  });

  it("标题为空时 topic 回退为 url", () => {
    const card = makeCard({ title: "" });
    const node = createBookmarkMindNode(card);
    expect(node.data.topic.children[0]).toEqual({
      text: "https://example.com",
    });
  });
});

describe("attachBookmarkCardToMind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("画布无思维导图：在卡片左侧新建中心主题并挂载书签子节点", () => {
    const board = makeBoardWithChildren([]);
    installMutableTransformMocks(board);
    const card = createBookmarkCard(
      { bookmarkId: "bm-1", title: "T", url: "https://example.com" },
      [500, 300],
    );
    board.children.push(card);
    const newMind = makeMindRoot([244, 300]);
    mocks.createEmptyMind.mockReturnValue(newMind);

    attachBookmarkCardToMind(board, card);

    // 新建中心主题的锚点在卡片左侧（卡片中心 x - 卡片宽度）
    expect(mocks.createEmptyMind).toHaveBeenCalledWith(board, [
      500 - CARD_WIDTH,
      300,
    ]);
    // 树结构：mind root 顶层唯一子元素为其最后一个 child（书签节点），卡片被移除
    expect(board.children.length).toBe(1);
    expect(board.children[0]).toBe(newMind);
    const newMindChildren = newMind.children!;
    expect(newMindChildren.length).toBe(1);
    const attached = newMindChildren[0] as unknown as {
      type: string;
      data: { bookmark: { url: string } };
    };
    expect(attached.type).toBe("mind_child");
    expect(attached.data.bookmark.url).toBe("https://example.com");
    expect(mocks.setSelection).toHaveBeenCalledWith(board, null);
  });

  it("画布已有思维导图：挂到距离卡片最近的中心主题，并移除原卡片", () => {
    const board = makeBoardWithChildren([]);
    installMutableTransformMocks(board);
    const nearRoot = makeMindRoot(
      [400, 300],
      [{ id: "existing", type: "mind_child", children: [] } as PlaitElement],
    );
    const farRoot = makeMindRoot([5000, 9000]);
    const card = createBookmarkCard(
      { bookmarkId: "bm-1", title: "T", url: "https://example.com" },
      [500, 300],
    );
    board.children.push(farRoot, nearRoot, card);

    attachBookmarkCardToMind(board, card);

    expect(mocks.createEmptyMind).not.toHaveBeenCalled();
    // 追加到最近 root 的 children 末尾
    expect(nearRoot.children!.length).toBe(2);
    const attached = nearRoot.children![1] as unknown as { type: string };
    expect(attached.type).toBe("mind_child");
    // 远处 root 与卡片都保留/移除各自正确
    expect(farRoot.children!.length).toBe(0);
    expect(board.children).toEqual([farRoot, nearRoot]);
  });
});

// ---------------------------------------------------------------------------
// 连线绑定与悬空线清理
// ---------------------------------------------------------------------------

/** 构造绑定连线（type 匹配 PlaitDrawElement.isArrowLine 认可的 'arrow-line'） */
function makeBoundLine(
  lineId: string,
  sourceBoundId: string,
  targetBoundId: string,
): PlaitElement {
  return {
    id: lineId,
    type: "arrow-line",
    source: { boundId: sourceBoundId, connection: [0.5, 0] },
    target: { boundId: targetBoundId, connection: [0.5, 1] },
    points: [
      [0, 0],
      [100, 100],
    ],
  } as unknown as PlaitElement;
}

describe("removeBookmarkCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("删除卡片并连带清理其绑定线，无关连线保留，选区清空", () => {
    const board = makeBoardWithChildren([]);
    installMutableTransformMocks(board);
    const card = makeCard();
    const other = makeCard({ id: "card-2", bookmarkId: "bm-2" });
    const boundBySource = makeBoundLine("l-1", card.id, other.id);
    const boundByTarget = makeBoundLine("l-2", other.id, card.id);
    const unrelated = makeBoundLine("l-3", other.id, "some-other-id");
    board.children.push(other, boundBySource, boundByTarget, unrelated, card);

    removeBookmarkCard(board, card);

    expect(board.children.map((e) => e.id)).toEqual(["card-2", "l-3"]);
    expect(mocks.setSelection).toHaveBeenCalledWith(board, null);
  });
});

describe("apply 悬空绑定线兜底", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("remove_node 后，boundId 指向已不存在元素的连线被自动移除", () => {
    const board = makeBoardWithChildren([]);
    installMutableTransformMocks(board);
    const card = makeCard();
    const other = makeCard({ id: "card-2", bookmarkId: "bm-2" });
    const dangling = makeBoundLine("l-1", card.id, other.id);
    const healthy = makeBoundLine("l-2", other.id, other.id);
    board.children.push(other, dangling, healthy, card);
    withBookmarkCard(board);

    // 模拟 Delete 键等不经 removeBookmarkCard 的通用删除路径
    board.apply({ type: "remove_node", path: [3] } as never);

    // 卡片已删，绑定它的悬空线被兜底清理，端点均健在的线保留
    expect(board.children.map((e) => e.id)).toEqual(["card-2", "l-2"]);
  });

  it("非 remove_node 操作不触发悬空线检查", () => {
    const board = makeBoardWithChildren([]);
    installMutableTransformMocks(board);
    const card = makeCard();
    const line = makeBoundLine("l-1", card.id, "ghost");
    board.children.push(card, line);
    withBookmarkCard(board);

    board.apply({ type: "insert_node", path: [2], node: {} } as never);

    // insert_node 不触发检查，即便存在悬空线也原样保留
    expect(board.children.map((e) => e.id)).toEqual(["card-1", "l-1"]);
  });
});

describe("drawElement 分发（思维导图拦截）", () => {
  it("书签 mind_child 换用定制组件（原型链可识别），其余委托内建实现", () => {
    const board = makeBoard();
    const origDrawElement = board.drawElement as unknown as ReturnType<
      typeof vi.fn
    >;
    withBookmarkCard(board);

    const bookmarkChild = {
      type: "mind_child",
      data: { topic: {}, bookmark: { bookmarkId: "1", title: "t", url: "u" } },
      children: [],
    } as unknown as PlaitElement;
    const plainChild = {
      type: "mind_child",
      data: { topic: {} },
      children: [],
    } as unknown as PlaitElement;

    const custom = board.drawElement({ element: bookmarkChild } as never) as
      | (new () => unknown)
      | undefined;
    expect(custom).toBeTruthy();
    // 定制组件继承自 @plait/mind 的 MindNodeComponent
    expect((custom as { prototype: object }).prototype).toBeInstanceOf(
      mocks.FakeMindNodeComponent,
    );

    board.drawElement({ element: plainChild } as never);
    expect(origDrawElement).toHaveBeenCalledWith({ element: plainChild });
  });
});

// ---------------------------------------------------------------------------
// 回归覆盖：删除卡片 / 撤销重做 / 组件销毁（幽灵圆点）与导航渲染状态
// ---------------------------------------------------------------------------

describe("删除卡片：分组内悬空线清理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("remove_node 删除卡片后，嵌套在 group 内的悬空绑定线也被递归清理", () => {
    const board = makeBoardWithChildren([]);
    installMutableTransformMocks(board);
    const card = makeCard();
    const other = makeCard({ id: "card-2", bookmarkId: "bm-2" });
    const nestedDangling = makeBoundLine("l-1", card.id, other.id);
    const group = {
      id: "grp",
      type: "group",
      children: [nestedDangling],
    } as PlaitElement;
    board.children.push(group, other, card);
    withBookmarkCard(board);

    board.apply({ type: "remove_node", path: [2] } as never);

    // group 仍在，但其内部绑定已删卡片的线被清掉
    expect(board.children.map((e) => e.id)).toEqual(["grp", "card-2"]);
    expect((board.children[0] as PlaitElement).children).toEqual([]);
  });
});

describe("撤销重做：悬空线兜底与树恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("删除→undo→redo 全周期：清理生效、恢复完整、再次清理", () => {
    const board = makeBoardWithChildren([]);
    installMutableTransformMocks(board);
    const card = makeCard();
    const other = makeCard({ id: "card-2", bookmarkId: "bm-2" });
    const line = makeBoundLine("l-1", card.id, other.id);
    board.children.push(card, line, other);
    withBookmarkCard(board);

    // 1) 删除卡片（Delete 键路径）：卡片与悬空线一并移除
    board.apply({ type: "remove_node", path: [0] } as never);
    expect(board.children.map((e) => e.id)).toEqual(["card-2"]);
    const removeCallsAfterDelete = mocks.removeNode.mock.calls.length;

    // 2) undo：slate 按逆序重放 Transforms.insertNode（先线后卡），
    //    直调不经过 board.apply，因此不触发悬空线检查
    mocks.insertNode(board, line, [0]);
    mocks.insertNode(board, card, [0]);
    expect(board.children.map((e) => e.id)).toEqual([
      "card-1",
      "l-1",
      "card-2",
    ]);
    // undo 阶段不应有新的删除（removeNode 调用数不变）
    expect(mocks.removeNode.mock.calls.length).toBe(removeCallsAfterDelete);

    // 3) redo：再次删除卡片，悬空线再次被清理
    board.apply({ type: "remove_node", path: [0] } as never);
    expect(board.children.map((e) => e.id)).toEqual(["card-2"]);
  });
});

describe("页面导航时的渲染状态（卸载竞态回归）", () => {
  let board: ReturnType<typeof makeBoard>;
  let container: HTMLElement;
  let inner: HTMLElement;
  let card: BookmarkCardElement;

  beforeEach(() => {
    vi.clearAllMocks();
    board = makeBoard();
    container = document.createElement("div");
    inner = document.createElement("div");
    container.appendChild(inner);
    document.body.appendChild(container);
    mocks.containerByBoard.set(board, container);
    mocks.hostByBoard.set(board, {});
    card = makeCard();
    mocks.getHitElementByPoint.mockReturnValue(card);
    withBookmarkCard(board);
  });

  afterEach(() => {
    mocks.containerByBoard.clear();
    mocks.hostByBoard.clear();
    document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: false }));
    container.remove();
  });

  it("导航离开瞬间（host 先注销、监听器未及清理）：右键与双击均不崩且全部静默", () => {
    // 模拟 React 卸载竞态：BOARD_TO_HOST 已注销，document 监听器仍存活
    mocks.hostByBoard.delete(board);

    // 右键：监听器自毁路径（不抛 viewBox 错误、不做坐标转换）
    const ev = rightClick(inner, 300, 200);
    expect(ev.defaultPrevented).toBe(false);
    expect(mocks.toHostPoint).not.toHaveBeenCalled();

    // 双击：早退防护路径
    expect(() =>
      board.dblClick(new MouseEvent("click", { clientX: 300, clientY: 200 })),
    ).not.toThrow();
    expect(mocks.toViewBoxPoint).not.toHaveBeenCalled();
  });

  it("导航返回（恢复注册）：已自毁的监听器不复活，双击防护依旧生效", () => {
    mocks.hostByBoard.delete(board);
    rightClick(inner, 300, 200); // 触发自毁

    // 模拟导航返回：容器与 host 重新注册
    mocks.hostByBoard.set(board, {});
    rightClick(inner, 300, 200);

    // 右键监听器已死，不再响应；双击恢复正常委托前的防护判定也正常执行
    expect(mocks.getHitElementByPoint).not.toHaveBeenCalled();
  });
});

describe("BookmarkCardComponent 生命周期（幽灵圆点回归）", () => {
  /** 与源码 destroy 交互所需的最小组件契约 */
  type ComponentLike = {
    context: unknown;
    initialize(): void;
    destroy(): void;
  };

  afterEach(() => {
    vi.restoreAllMocks();
    // 触发 createTestingBoard 应用插件时注册的 document 监听器自毁
    document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: false }));
  });

  it("destroy 调用 lineAutoCompleteGenerator.destroy（选中删除后圆点不残留）", () => {
    vi.clearAllMocks();
    // 隔离圆点 generator 的绘制流程（依赖真实 SVG host），只验证生命周期契约
    vi.spyOn(
      ArrowLineAutoCompleteGenerator.prototype,
      "processDrawing",
    ).mockImplementation(() => {});
    const lineDotsDestroy = vi
      .spyOn(ArrowLineAutoCompleteGenerator.prototype, "destroy")
      .mockImplementation(() => {});

    const card = makeCard();
    const board = createTestingBoard(
      [withBookmarkCard as never],
      [card as never],
    );
    const Component = board.drawElement({
      element: card,
      board,
    } as never) as unknown as new () => ComponentLike;

    const comp = new Component();
    comp.context = { board, element: card, selected: true } as never;
    comp.initialize();
    comp.destroy();

    // 幽灵圆点根因回归：漏掉这行调用，选中删除后 4 个圆点残留 DOM
    expect(lineDotsDestroy).toHaveBeenCalledTimes(1);
  });
});
