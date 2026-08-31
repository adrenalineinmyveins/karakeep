"use client";

/**
 * 书签卡片画布插件（karakeep 特色工具）
 *
 * 元素以 @plait/draw 的 geometry（shape=rectangle）存储，附带
 * { bookmarkId, title, url, favicon } 标记字段——这样连线（arrow-line）的
 * 绑定机制（source/target.boundId + connection 锚点）原生认可卡片：
 * - 上下左右四边中点即连接点（RectangleClient.getEdgeCenterPoints）；
 * - 从工具栏连线模式拖线、或选中卡片后从边中点提示圆点直接拖出连线；
 * - 卡片移动后线端按 boundId 在渲染时动态重算，自动跟随。
 * 渲染走自定义组件（白底圆角卡片：favicon + 标题 + 域名），支持点选/框选/
 * 拖拽移动，双击在浏览器新标签页打开书签链接。
 *
 * 渲染契约（与 drawnix 内置 freehand 插件同款，参照其 bundle 内实现）：
 * - board.drawElement(context) 必须返回一个「类」而非 React 组件——
 *   plait 的 ListRender 会 `new componentType()` 并调用
 *   initialize()/initializeListRender()/destroy() 等生命周期方法。
 * - 类继承 @plait/common 的 CommonElementFlavour，通过 Generator 产出 SVG 节点。
 * - 其余 board 钩子（getRectangle/isHit/isMovable 等）用覆写链模式按类型分发。
 */

import {
  createActiveGenerator,
  CommonElementFlavour,
  Generator,
} from "@plait/common";
import type { ActiveGenerator } from "@plait/common";
import {
  createG,
  getHitElementByPoint,
  PlaitBoard,
  RectangleClient,
  setSelectedElementsWithGroup,
  toHostPoint,
  toViewBoxPoint,
  Transforms,
} from "@plait/core";
import type {
  OnContextChanged,
  Path,
  Point,
  PlaitBoard as PlaitBoardType,
  PlaitElement,
  PlaitPlugin,
  PlaitPluginElementContext,
  Selection,
} from "@plait/core";
import {
  ArrowLineAutoCompleteGenerator,
  BasicShapes,
  PlaitDrawElement,
} from "@plait/draw";
import type { PlaitArrowLine, PlaitGeometry } from "@plait/draw";
import { createEmptyMind, MindNodeComponent, PlaitMind } from "@plait/mind";
import type {
  BaseData as MindBaseData,
  MindElement as MindElementType,
} from "@plait/mind";

/** 旧版书签卡片的 type 值（仅用于旧画布数据规范化识别，新数据不再产生） */
export const LEGACY_BOOKMARK_CARD_TYPE = "bookmarkCard";

/** auto-complete 提示圆点 generator 的注册 key（须与 @plait/draw 内部一致，
 * withArrowLineAutoCompleteReaction 借此 key 找到圆点做 hover 高亮） */
const LINE_AUTO_COMPLETE_GENERATOR_KEY = "line-auto-complete-generator";

// 声明合并：React 层在 afterInit 里注册该回调，右键书签卡片时收到通知
declare module "@plait/core" {
  interface PlaitBoard {
    openBookmarkCardMenu?: (
      element: BookmarkCardElement,
      clientPoint: Point,
    ) => void;
  }
}

export const CARD_WIDTH = 256;
export const CARD_HEIGHT = 88;

/**
 * 书签卡片元素 = geometry(rectangle) + 书签标记字段。
 * 借道 @plait/draw 内建的 shape 体系（isShapeElement 认可 type='geometry'），
 * 连线绑定 / 四边中点连接点 / 选中提示圆点 / 移动跟随全部复用内建机制，
 * 渲染由本插件的 drawElement 覆写替换为书签卡片外观。
 */
export interface BookmarkCardElement extends PlaitGeometry {
  /** 书签身份标记：isBookmarkCard 靠它从 geometry 中识别书签卡片 */
  bookmarkId: string;
  title: string;
  url: string;
  favicon?: string | null;
}

export const isBookmarkCard = (
  element: PlaitElement | undefined,
): element is BookmarkCardElement =>
  !!element &&
  element.type === "geometry" &&
  !!(element as BookmarkCardElement).bookmarkId;

export function createBookmarkCard(
  opts: {
    bookmarkId: string;
    title: string;
    url: string;
    favicon?: string | null;
  },
  center: Point,
): BookmarkCardElement {
  const hw = CARD_WIDTH / 2;
  const hh = CARD_HEIGHT / 2;
  return {
    id: crypto.randomUUID(),
    type: "geometry",
    shape: BasicShapes.rectangle,
    bookmarkId: opts.bookmarkId,
    title: opts.title,
    url: opts.url,
    favicon: opts.favicon ?? null,
    // geometry 元素约定 points 为 [左上, 右下] 两点式
    points: [
      [center[0] - hw, center[1] - hh],
      [center[0] + hw, center[1] + hh],
    ],
  };
}

/**
 * 旧画布数据规范化：把早期版本 { type: 'bookmarkCard', points: 四角 } 的卡片
 * 转换为现行 geometry 两点式格式（递归穿透分组等容器元素）。
 * 在 CanvasEditor 加载画布数据时调用一次，保存时自然写回新格式。
 */
export function normalizeCanvasValue(
  elements: PlaitElement[],
): PlaitElement[] {
  return elements.map((el) => {
    if (el.type === LEGACY_BOOKMARK_CARD_TYPE) {
      const rect = RectangleClient.getRectangleByPoints(
        (el.points as Point[]) ?? [],
      );
      return {
        ...el,
        type: "geometry",
        shape: BasicShapes.rectangle,
        points: [
          [rect.x, rect.y],
          [rect.x + rect.width, rect.y + rect.height],
        ],
      } as PlaitElement;
    }
    if (el.children?.length) {
      return {
        ...el,
        children: normalizeCanvasValue(el.children as PlaitElement[]),
      };
    }
    return el;
  });
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// 书签 × 思维导图集成
//
// 思维导图（@plait/mind）是树形 slate 元素：根 type='mind'，子节点 type='mind_child'，
// 节点间连线由 MindNodeComponent.drawLink() 按树结构自动绘制。
// 把书签挂进思维导图 = 把卡片转换为 mind_child（topic 放标题，data.bookmark 存原始数据），
// 布局/连线/拖拽重排/折叠等内建能力全部免费获得，
// 自定义组件仅额外绘制 favicon + 域名徽标以保持书签辨识度。
// ---------------------------------------------------------------------------

/** 书签 mind 节点 data 上的扩展载荷 */
export interface BookmarkMindPayload {
  bookmarkId: string;
  title: string;
  url: string;
  favicon?: string | null;
}

export type BookmarkMindElement = MindElementType<
  MindBaseData & { bookmark?: BookmarkMindPayload }
>;

/** 该元素是否为「携带书签数据的思维导图子节点」 */
export const isBookmarkMindNode = (
  element: PlaitElement | undefined | null,
): element is BookmarkMindElement =>
  !!element &&
  element.type === "mind_child" &&
  !!(element as BookmarkMindElement).data?.bookmark;

/** 由书签卡片构造 mind_child 元素（topic 承载标题，保留编辑能力） */
export function createBookmarkMindNode(
  card: BookmarkCardElement,
): BookmarkMindElement {
  return {
    id: crypto.randomUUID(),
    type: "mind_child",
    data: {
      topic: {
        type: "paragraph",
        children: [{ text: card.title || card.url }],
      },
      bookmark: {
        bookmarkId: card.bookmarkId,
        title: card.title,
        url: card.url,
        favicon: card.favicon,
      },
    },
    children: [],
  } as BookmarkMindElement;
}

function centerOfPoints(points: Point[]): Point {
  const { x, y, width, height } = RectangleClient.getRectangleByPoints(points);
  return [x + width / 2, y + height / 2];
}

/** 是否为绑定到指定元素上的连线 */
function isLineBoundTo(line: PlaitElement, elementId: string): boolean {
  return (
    PlaitDrawElement.isArrowLine(line) &&
    ((line as PlaitArrowLine).source.boundId === elementId ||
      (line as PlaitArrowLine).target.boundId === elementId)
  );
}

/**
 * 移除所有绑定到指定元素的连线。倒序遍历保证同层删除不影响后续索引。
 * 卡片消失时若留下 boundId 悬空的线，PlaitArrowLine.getPoints 在渲染时
 * 会对 undefined 取 points 而崩溃，因此删除卡片必须连带清理绑定线。
 */
function removeLinesBoundTo(board: PlaitBoardType, elementId: string): void {
  const walk = (elements: PlaitElement[], base: Path) => {
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (isLineBoundTo(el, elementId)) {
        Transforms.removeNode(board, [...base, i]);
      } else if (el.children?.length) {
        walk(el.children as PlaitElement[], [...base, i]);
      }
    }
  };
  walk(board.children, []);
}

/**
 * 删除书签卡片（连带其绑定连线）——右键菜单「删除」等入口统一走这里。
 */
export function removeBookmarkCard(
  board: PlaitBoardType,
  card: BookmarkCardElement,
): void {
  const cardPath = PlaitBoard.findPath(board, card);
  if (cardPath) {
    Transforms.removeNode(board, cardPath);
  }
  removeLinesBoundTo(board, card.id);
  Transforms.setSelection(board, null);
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * 把独立书签卡片挂入思维导图：
 * 1. 找距离卡片最近的思维导图中心主题（type='mind'）；画布没有则在其左侧新建一个；
 * 2. 将卡片转换为 mind_child 追加为该中心的最后一个子节点（连线由布局自动绘制）；
 * 3. 移除原独立卡片（及其绑定连线——mind 节点不是可绑定元素，留下必悬空）。
 * 两个 path 均在变更前计算：child 插入发生在 root 内部，不影响卡片的顶层路径。
 */
export function attachBookmarkCardToMind(
  board: PlaitBoardType,
  card: BookmarkCardElement,
): void {
  const cardCenter = centerOfPoints(card.points);
  let root: PlaitElement | undefined;
  let bestDistance = Infinity;
  for (const child of board.children) {
    if (PlaitMind.isMind(child)) {
      const d = distanceBetween(centerOfPoints(child.points), cardCenter);
      if (d < bestDistance) {
        bestDistance = d;
        root = child;
      }
    }
  }
  if (!root) {
    root = createEmptyMind(board, [
      cardCenter[0] - CARD_WIDTH,
      cardCenter[1],
    ]);
    Transforms.insertNode(board, root, [board.children.length]);
  }
  const rootPath = PlaitBoard.findPath(board, root);
  const cardPath = PlaitBoard.findPath(board, card);
  Transforms.insertNode(
    board,
    createBookmarkMindNode(card),
    [...rootPath, root.children?.length ?? 0],
  );
  if (cardPath) {
    Transforms.removeNode(board, cardPath);
  }
  removeLinesBoundTo(board, card.id);
  Transforms.setSelection(board, null);
}

/**
 * 书签 mind 节点组件：继承原生 MindNodeComponent（形状/连线/topic 编辑/折叠全保留），
 * 在节点下方追加 favicon + 域名徽标。
 */
class BookmarkMindNodeComponent extends MindNodeComponent {
  private bookmarkBadgeG: SVGGElement | null = null;

  initialize(): void {
    super.initialize();
    this.drawBookmarkBadge();
  }

  onContextChanged(
    value: PlaitPluginElementContext<never, never>,
    previous: PlaitPluginElementContext<never, never>,
  ): void {
    super.onContextChanged(
      value as never,
      previous as never,
    );
    this.drawBookmarkBadge();
  }

  /** 节点下方一行徽标：favicon（14px）+ 域名（10px 灰字） */
  private drawBookmarkBadge(): void {
    this.bookmarkBadgeG?.remove();
    this.bookmarkBadgeG = null;
    const payload = (this.element as BookmarkMindElement).data?.bookmark;
    if (!payload || !this.node) return;
    const { x, y, width } = this.node;
    const badgeY = y + this.node.height;
    const maxTextWidth = width;
    const g = createG();
    if (payload.favicon) {
      g.append(
        svgEl("image", {
          x,
          y: badgeY + 4,
          width: 14,
          height: 14,
          href: payload.favicon,
          preserveAspectRatio: "xMidYMid meet",
        }),
      );
    } else {
      g.append(
        svgEl("circle", {
          cx: x + 7,
          cy: badgeY + 11,
          r: 7,
          fill: "#6698ff",
        }),
      );
      g.append(
        svgEl(
          "text",
          {
            x: x + 7,
            y: badgeY + 14.5,
            "text-anchor": "middle",
            "font-size": 9,
            fill: "#ffffff",
            "font-weight": 600,
          },
          (payload.title || "U").charAt(0).toUpperCase(),
        ),
      );
    }
    g.append(
      svgEl(
        "text",
        {
          x: x + 18,
          y: badgeY + 15,
          "font-size": 10,
          fill: "#7a7a7a",
          "font-family": "inherit",
        },
        hostnameOf(payload.url).slice(0, Math.max(1, Math.floor(maxTextWidth / 6))),
      ),
    );
    this.getElementG().append(g);
    this.bookmarkBadgeG = g;
  }
}

/** 标题截断为两行，超出部分以省略号结尾 */
function wrapTitle(title: string): [string, string] {
  const max = 26; // 每行约 26 个半角字符（卡片文本区宽度估算）
  const line1 = title.slice(0, max);
  if (title.length <= max) return [title, ""];
  const rest = title.slice(max);
  const line2 = rest.length > max ? `${rest.slice(0, max - 1)}…` : rest;
  return [line1, line2];
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(
  tag: string,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 产出卡片 SVG（rect 背景 + favicon/首字母 + 标题两行 + 域名 + 外链角标） */
class BookmarkCardGenerator extends Generator<BookmarkCardElement> {
  draw(element: BookmarkCardElement): SVGGElement {
    const { x, y, width, height } = RectangleClient.getRectangleByPoints(
      element.points,
    );
    const g = createG();

    g.append(
      svgEl("rect", {
        x,
        y,
        width,
        height,
        rx: 8,
        fill: "#ffffff",
        stroke: "#d6d6d6",
        "stroke-width": 1,
      }),
    );

    if (element.favicon) {
      g.append(
        svgEl("image", {
          x: x + 14,
          y: y + 15,
          width: 20,
          height: 20,
          href: element.favicon,
          preserveAspectRatio: "xMidYMid meet",
        }),
      );
    } else {
      g.append(svgEl("circle", { cx: x + 24, cy: y + 25, r: 11, fill: "#6698ff" }));
      g.append(
        svgEl(
          "text",
          {
            x: x + 24,
            y: y + 30,
            "text-anchor": "middle",
            "font-size": 13,
            fill: "#ffffff",
            "font-weight": 600,
          },
          (element.title || "U").charAt(0).toUpperCase(),
        ),
      );
    }

    const [line1, line2] = wrapTitle(element.title || "Untitled");
    g.append(
      svgEl(
        "text",
        {
          x: x + 46,
          y: y + 26,
          "font-size": 13,
          fill: "#242424",
          "font-weight": 500,
          "font-family": "inherit",
        },
        line1,
      ),
    );
    if (line2) {
      g.append(
        svgEl(
          "text",
          {
            x: x + 46,
            y: y + 43,
            "font-size": 13,
            fill: "#242424",
            "font-weight": 500,
            "font-family": "inherit",
          },
          line2,
        ),
      );
    }
    g.append(
      svgEl(
        "text",
        { x: x + 46, y: y + 68, "font-size": 11, fill: "#7a7a7a" },
        hostnameOf(element.url),
      ),
    );

    // 右下角外链角标，提示可双击打开
    const badge = createG();
    badge.setAttribute(
      "transform",
      `translate(${x + width - 26}, ${y + height - 24})`,
    );
    badge.setAttribute("opacity", "0.45");
    badge.append(
      svgEl("rect", {
        width: 14,
        height: 14,
        rx: 3,
        fill: "none",
        stroke: "#5c5c5c",
      }),
    );
    badge.append(
      svgEl("path", {
        d: "M10 4h-3M10 4v3M10 4l-6 6",
        stroke: "#5c5c5c",
        fill: "none",
      }),
    );
    g.append(badge);

    return g;
  }

  canDraw(): boolean {
    return true;
  }
}

/** 书签卡片元素组件（plait 类组件契约） */
class BookmarkCardComponent extends CommonElementFlavour<
  BookmarkCardElement,
  PlaitBoardType
> {
  declare activeGenerator: ActiveGenerator<BookmarkCardElement>;
  declare generator: BookmarkCardGenerator;
  declare lineAutoCompleteGenerator: ArrowLineAutoCompleteGenerator<BookmarkCardElement>;

  initializeGenerator(): void {
    this.activeGenerator = createActiveGenerator(this.board, {
      getRectangle: (element) =>
        RectangleClient.getRectangleByPoints(element.points),
      getStrokeWidth: () => 1,
      getStrokeOpacity: () => 1,
      hasResizeHandle: () => false,
    });
    this.generator = new BookmarkCardGenerator(this.board);
    // 挂载与内建 GeometryComponent 同款的四边中点提示圆点：
    // 单选卡片时显示，从圆点按下拖动即可拉出一条绑定连线
    // （拖动逻辑由内建 withArrowLineAutoComplete 覆写 pointerDown 完成，
    //  它通过 getSelectedDrawElements + isShapeElement 认可 geometry 卡片）。
    // 注册 key 必须与 @plait/draw 内部一致，hover 高亮反应才能找到圆点。
    this.lineAutoCompleteGenerator = new ArrowLineAutoCompleteGenerator(
      this.board,
    );
    this.getRef().addGenerator(
      LINE_AUTO_COMPLETE_GENERATOR_KEY,
      this.lineAutoCompleteGenerator,
    );
    this.getRef().updateActiveSection = () => {
      this.activeGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected },
      );
      this.lineAutoCompleteGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected },
      );
    };
  }

  initialize(): void {
    super.initialize();
    this.initializeGenerator();
    this.generator.processDrawing(this.element, this.getElementG());
    this.lineAutoCompleteGenerator.processDrawing(
      this.element,
      PlaitBoard.getElementTopHost(this.board),
      { selected: this.selected },
    );
  }

  onContextChanged: OnContextChanged<
    BookmarkCardElement,
    PlaitBoardType
  >["onContextChanged"] = (current, previous) => {
    if (current.element !== previous.element || current.hasThemeChanged) {
      this.generator.processDrawing(this.element, this.getElementG());
      this.activeGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected },
      );
      this.lineAutoCompleteGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected },
      );
    } else if (current.selected !== previous.selected || current.selected) {
      this.activeGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected },
      );
      this.lineAutoCompleteGenerator.processDrawing(
        this.element,
        PlaitBoard.getActiveHost(this.board),
        { selected: this.selected },
      );
    }
  };

  destroy(): void {
    super.destroy();
    this.activeGenerator?.destroy();
    // 圆点挂在 activeHost 上（不在元素自身 g 内），不随元素 g 移除——
    // 选中状态下删除卡片时若漏掉这句，4 个提示圆点会残留在 DOM 且不断累积
    this.lineAutoCompleteGenerator?.destroy();
  }
}

export const withBookmarkCard = (board: PlaitBoardType): PlaitBoardType => {
  const {
    drawElement,
    getRectangle,
    isRectangleHit,
    isHit,
    isMovable,
    isAlign,
    dblClick,
    apply,
  } = board;

  // 悬空绑定线兜底：Delete 键/撤销等通用删除路径不经过 removeBookmarkCard，
  // 卡片消失后残留 boundId 的连线会让渲染崩溃（PlaitArrowLine.getPoints 对
  // undefined 取 points）。在 remove_node 后全量检查一次并移除悬空线。
  // undo/redo 恢复元素（insert_node）不触发检查——plait 的重绘在微任务中
  // 批量执行，undo 批内的短暂悬空不会走到渲染。
  let cleaningDanglingLines = false;
  board.apply = (op) => {
    apply(op);
    if (cleaningDanglingLines || op.type !== "remove_node") return;
    cleaningDanglingLines = true;
    try {
      const existingIds = new Set<string>();
      const collectIds = (elements: PlaitElement[]) => {
        for (const el of elements) {
          existingIds.add(el.id);
          if (el.children?.length) collectIds(el.children as PlaitElement[]);
        }
      };
      collectIds(board.children);
      const walk = (elements: PlaitElement[], base: Path) => {
        for (let i = elements.length - 1; i >= 0; i--) {
          const el = elements[i];
          const line = PlaitDrawElement.isArrowLine(el)
            ? (el as PlaitArrowLine)
            : null;
          if (
            line &&
            ((line.source.boundId && !existingIds.has(line.source.boundId)) ||
              (line.target.boundId && !existingIds.has(line.target.boundId)))
          ) {
            Transforms.removeNode(board, [...base, i]);
          } else if (el.children?.length) {
            walk(el.children as PlaitElement[], [...base, i]);
          }
        }
      };
      walk(board.children, []);
    } finally {
      cleaningDanglingLines = false;
    }
  };

  board.drawElement = (context: PlaitPluginElementContext) => {
    if (isBookmarkCard(context.element)) {
      return BookmarkCardComponent as never;
    }
    // 本插件经由 patch 后的 Drawnix 注入在内置 withMind 之后，
    // 此处先于 mind 的分发拿到机会：带书签数据的 mind_child 换用书签定制组件，
    // 其余 mind 元素照旧走内建 MindNodeComponent/PlaitMindComponent
    if (isBookmarkMindNode(context.element)) {
      return BookmarkMindNodeComponent as never;
    }
    return drawElement(context);
  };

  board.getRectangle = (element) =>
    isBookmarkCard(element)
      ? RectangleClient.getRectangleByPoints(element.points)
      : getRectangle(element);

  board.isRectangleHit = (element, range: Selection) => {
    if (isBookmarkCard(element)) {
      const rect = RectangleClient.getRectangleByPoints(element.points);
      const rangeRect = RectangleClient.getRectangleByPoints([
        range.anchor,
        range.focus,
      ]);
      return RectangleClient.isHit(rect, rangeRect);
    }
    return isRectangleHit(element, range);
  };

  board.isHit = (element, point: Point, isStrict?: boolean) => {
    if (isBookmarkCard(element)) {
      const r = RectangleClient.getRectangleByPoints(element.points);
      return (
        point[0] >= r.x &&
        point[0] <= r.x + r.width &&
        point[1] >= r.y &&
        point[1] <= r.y + r.height
      );
    }
    return isHit(element, point, isStrict);
  };

  board.isMovable = (element) =>
    isBookmarkCard(element) ? true : isMovable(element);

  board.isAlign = (element) =>
    isBookmarkCard(element) ? true : isAlign(element);

  board.dblClick = (event: MouseEvent) => {
    // 画布卸载瞬间（host 已从注册表注销）钩子仍可能被事件桥调用一次，
    // 此时 toViewBoxPoint 内部取 host.viewBox 会抛
    // "Cannot read properties of undefined (reading 'viewBox')"，直接吞掉
    if (!PlaitBoard.getHost(board)) return;
    // 注意：toViewBoxPoint 入参是 host 坐标（画布宿主元素左上角为原点），
    // clientX/Y 是视口屏幕坐标，必须先经 toHostPoint 转换
    const point = toViewBoxPoint(board, toHostPoint(board, event.clientX, event.clientY));
    const hit = getHitElementByPoint(board, point, (e) => isBookmarkCard(e));
    if (isBookmarkCard(hit)) {
      window.open(hit.url, "_blank", "noopener,noreferrer");
      return;
    }
    dblClick(event);
  };

  // 右键书签卡片：阻止浏览器默认菜单，选中该卡片并通知 React 层弹出自定义菜单
  // 注意：插件初始化时画布容器还未挂载 DOM（getBoardContainer 返回 undefined），
  // 因此监听挂在 document 上，事件触发时再惰性解析容器并判断目标是否在画布内。
  // plait 无插件销毁钩子，且 React StrictMode 开发模式会双重应用插件——
  // 不能用「应用时移除上一个监听器」的方式（会误删存活 board 的监听器）。
  // 改为自毁式：handler 触发时若所属画布容器未注册或已脱离文档，自行移除监听器，
  // 既能清理卸载画布的残留，又不影响当前画布。
  const onContextMenu = (event: MouseEvent) => {
    const container = PlaitBoard.getBoardContainer(board);
    // getHost 一并校验：本监听器是 document 级的，画布卸载后仍存活，
    // 若 host 已注销（BOARD_TO_HOST 已删）而事件先于自毁触发，
    // 后续 toViewBoxPoint 会对 undefined 取 viewBox 而崩溃
    if (
      !container ||
      !container.isConnected ||
      !PlaitBoard.getHost(board)
    ) {
      document.removeEventListener("contextmenu", onContextMenu);
      return;
    }
    if (!container.contains(event.target as Node)) return;
    const point = toViewBoxPoint(board, toHostPoint(board, event.clientX, event.clientY));
    const hit = getHitElementByPoint(board, point, (e) => isBookmarkCard(e));
    if (isBookmarkCard(hit)) {
      event.preventDefault();
      // plait 的 setSelection 期望 {anchor, focus} 或 null；
      // 选中单个元素应使用 setSelectedElementsWithGroup
      setSelectedElementsWithGroup(board, [hit], false);
      board.openBookmarkCardMenu?.(hit, [event.clientX, event.clientY]);
    }
  };
  document.addEventListener("contextmenu", onContextMenu);

  return board;
};

export const bookmarkCardPlugins: PlaitPlugin[] = [withBookmarkCard];
