/**
 * Agent 工具集
 *
 * 每个工具用 Zod 定义参数，通过 zodToToolSchema 转换，
 * 内部通过 createCallerFactory 调用已有 tRPC procedure（携带用户认证上下文）。
 */

import { BookmarkTypes } from "@saiye/shared/types/bookmarks";
import serverConfig from "@saiye/shared/config";
import { z } from "zod";

import { createCallerFactory, type Context } from "../../index";
import type { ToolDefinition } from "./sdkAdapter";
import { zodToToolSchema } from "./sdkAdapter";

// ── 书签卡片尺寸常量（与 web 端 withBookmarkCard 渲染尺寸一致） ──
const BOOKMARK_CARD_WIDTH = 256;
const BOOKMARK_CARD_HEIGHT = 88;
/** 网格布局：每行 3 张卡，水平/垂直间距 80 */
const GRID_COLUMNS = 3;
const GRID_GAP = 80;

/**
 * 创建内部 caller —— 延迟到运行时，避免与 appRouter 的循环依赖
 */
async function getCaller(ctx: Context) {
  const { appRouter } = await import("../../routers/_app");
  return createCallerFactory(appRouter)(ctx);
}

// ── jsdom 浏览器环境模拟 ─────────────────────────────────
//
// mermaid-to-drawnix 在服务端运行时依赖 DOM API（getBBox /
// getComputedTextLength / canvas 等），这里用 jsdom 补齐并
// mock 掉测量类 API（只需要数值稳定，不需要真实排版）。

let browserEnvReady = false;

async function ensureBrowserLikeEnv() {
  if (browserEnvReady) return;
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // 1. SVG 文本测量
  const svgProto = win.SVGElement.prototype as unknown as {
    getBBox: () => { x: number; y: number; width: number; height: number };
    getComputedTextLength: () => number;
  };
  svgProto.getBBox = () => ({
    x: 0,
    y: 0,
    width: 100,
    height: 40,
  });
  svgProto.getComputedTextLength = function (this: SVGElement) {
    const text = this.textContent ?? "";
    let width = 0;
    for (const ch of text) {
      width += ch.charCodeAt(0) > 255 ? 14 : 8.4;
    }
    return width;
  };

  // 2. 视口尺寸
  Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
    get: () => 600,
  });
  Object.defineProperty(win.HTMLElement.prototype, "clientHeight", {
    get: () => 400,
  });

  // 3. 计算样式：box-model 属性空值时返回 "0px"
  const origGetComputedStyle = win.getComputedStyle.bind(win);
  (
    win as unknown as { getComputedStyle: (el: Element) => CSSStyleDeclaration }
  ).getComputedStyle = (el: Element) => {
    const style = origGetComputedStyle(el);
    const origGet = style.getPropertyValue.bind(style);
    style.getPropertyValue = (name: string) => {
      const v = origGet(name);
      return v === "" && /padding|margin|border/.test(name) ? "0px" : v;
    };
    return style;
  };

  // 4. getBoundingClientRect：支持从 viewBox 解析尺寸
  const getBoundingClientRect = function (this: Element) {
    const viewBox = this.getAttribute?.("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
        const [, , width, height] = parts;
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: width,
          bottom: height,
          width,
          height,
        };
      }
    }
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    };
  };
  (
    win as unknown as {
      Element: { prototype: Element };
    }
  ).Element.prototype.getBoundingClientRect =
    getBoundingClientRect as unknown as () => DOMRect;

  // 5. Canvas 2D 上下文（mermaid 用 measureText 估算文本宽度）
  (
    win as unknown as {
      HTMLCanvasElement: { prototype: { getContext: () => unknown } };
    }
  ).HTMLCanvasElement.prototype.getContext = () => {
    let font = "";
    return {
      set font(f: string) {
        font = f;
      },
      get font() {
        return font;
      },
      measureText(text: string) {
        const m = /(\d+(?:\.\d+)?)px/.exec(font);
        const fontSize = m ? parseFloat(m[1]) : 14;
        let width = 0;
        for (const ch of text) {
          width += ch.charCodeAt(0) > 255 ? fontSize : 0.6 * fontSize;
        }
        return {
          width,
          actualBoundingBoxAscent: fontSize,
          actualBoundingBoxDescent: 0.25 * fontSize,
        };
      },
      setTransform: () => {},
      save: () => {},
      restore: () => {},
      clearRect: () => {},
    };
  };

  // 6. 注入全局，让 @plait/mermaid 系列拿到 window/document/navigator
  Object.defineProperty(globalThis, "window", {
    value: win,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: win.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: win.navigator,
    configurable: true,
  });

  browserEnvReady = true;
}

// ── 书签卡片元素构造 ─────────────────────────────────────

interface BookmarkCardInput {
  id: string;
  title: string | null;
  url: string;
  favicon: string | null;
}

interface CanvasLinkInput {
  source: string;
  target: string;
}

interface BookmarkCardElement {
  id: string;
  type: "geometry";
  shape: "rectangle";
  bookmarkId: string;
  title: string;
  url: string;
  favicon: string | null;
  points: [[number, number], [number, number]];
  opacity: number;
}

interface CanvasLineElement {
  id: string;
  type: "arrow-line";
  shape: "straight";
  source: {
    marker: string;
    boundId: string;
    connection: [number, number];
  };
  target: {
    marker: string;
    boundId: string;
    connection: [number, number];
  };
  texts: unknown[];
  strokeWidth: number;
  points: [[number, number], [number, number]];
  opacity: number;
}

/**
 * 把书签列表转换为画布元素：
 * - 卡片：网格布局（每行 3 张，间距 80），尺寸 256×88
 * - 连线：绑定两卡「相向边」的中点（上下相邻 → 底边↔顶边；左右相邻 → 右边↔左边），
 *   端点始终落在卡片边框上，避免斜穿/纵穿卡片
 *
 * ⚠️ 字段集必须与编辑器手绘元素逐字段对齐：
 * arrow-line 的 texts / strokeWidth / marker / connection 缺一不可，
 * @plait/draw 的 drawArrowLineMask 会对 texts.forEach 硬解引用，缺字段渲染即崩。
 */
/**
 * connection 比例锚点 → 卡片绝对坐标点（[rx, ry] 相对卡片左上角）。
 * 四边中点：[0.5,0] 上 / [0.5,1] 下 / [0,0.5] 左 / [1,0.5] 右
 */
function connectionToPoint(
  card: BookmarkCardElement,
  conn: [number, number],
): [number, number] {
  return [
    card.points[0][0] + conn[0] * BOOKMARK_CARD_WIDTH,
    card.points[0][1] + conn[1] * BOOKMARK_CARD_HEIGHT,
  ];
}

/**
 * 按两卡中心点的相对位置选「相向边」锚点：
 * 垂直关系为主 → 源底边↔目标顶边（反向则对调）；
 * 水平关系为主 → 源右边↔目标左边（反向则对调）。
 * 返回 [sourceConnection, targetConnection]。
 */
function facingConnections(
  src: BookmarkCardElement,
  tgt: BookmarkCardElement,
): [[number, number], [number, number]] {
  const dx = tgt.points[0][0] - src.points[0][0];
  const dy = tgt.points[0][1] - src.points[0][1];
  // 同尺寸卡片下用左上角差值即可判断相对方位
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0
      ? [
          [0.5, 1],
          [0.5, 0],
        ] // 目标在下方：源底边 → 目标顶边
      : [
          [0.5, 0],
          [0.5, 1],
        ]; // 目标在上方
  }
  return dx >= 0
    ? [
        [1, 0.5],
        [0, 0.5],
      ] // 目标在右侧：源右边 → 目标左边
    : [
        [0, 0.5],
        [1, 0.5],
      ]; // 目标在左侧
}

// ── mermaid 连线重锚 ─────────────────────────────────────
//
// mermaid-to-drawnix 的 connection 由折线端点直接换算比例，而
// mermaid 布局的端点与节点框之间留有 gap（diamond 等尖形状更大），
// 导致锚点越界（负数 / >1）或悬在框内，渲染时线端点不贴框。
// 修复：按折线走向从节点中心射线打到矩形边界，重算锚点。

type Pt = [number, number];

function elementRect(el: { points?: Pt[] }): {
  x: number;
  y: number;
  w: number;
  h: number;
} | null {
  if (!el.points || el.points.length < 2) return null;
  const xs = el.points.map((p) => p[0]);
  const ys = el.points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** 从 center 沿 dir 射线，返回与矩形边界的第一个交点；方向无效返回 null */
function rayToRectEdge(
  center: Pt,
  dir: Pt,
  rect: { x: number; y: number; w: number; h: number },
): Pt | null {
  let t = Infinity;
  if (dir[0] > 0) t = Math.min(t, (rect.x + rect.w - center[0]) / dir[0]);
  else if (dir[0] < 0) t = Math.min(t, (rect.x - center[0]) / dir[0]);
  if (dir[1] > 0) t = Math.min(t, (rect.y + rect.h - center[1]) / dir[1]);
  else if (dir[1] < 0) t = Math.min(t, (rect.y - center[1]) / dir[1]);
  if (!Number.isFinite(t) || t <= 0) return null;
  return [center[0] + t * dir[0], center[1] + t * dir[1]];
}

function reanchorMermaidLines<
  T extends { type: string; id: string; points?: Pt[] },
>(elements: T[]): T[] {
  const rects = new Map<string, ReturnType<typeof elementRect>>();
  for (const el of elements) {
    if (el.type === "geometry") rects.set(el.id, elementRect(el));
  }
  return elements.map((el) => {
    if (el.type !== "arrow-line" || !el.points || el.points.length < 2) {
      return el;
    }
    const pts = el.points;
    const next = { ...el } as T & {
      source?: { boundId?: string; connection?: [number, number] };
      target?: { boundId?: string; connection?: [number, number] };
    };
    // 起点：沿折线出发方向（pts[0]→pts[1]）从源中心打到边界
    const srcRect = next.source?.boundId
      ? rects.get(next.source.boundId)
      : null;
    if (srcRect && next.source) {
      const c: Pt = [srcRect.x + srcRect.w / 2, srcRect.y + srcRect.h / 2];
      const dir: Pt = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
      const hit =
        rayToRectEdge(c, dir, srcRect) ??
        rayToRectEdge(
          c,
          [
            pts[pts.length - 1][0] - pts[0][0],
            pts[pts.length - 1][1] - pts[0][1],
          ],
          srcRect,
        );
      if (hit) {
        next.source = {
          ...next.source,
          connection: [
            (hit[0] - srcRect.x) / srcRect.w,
            (hit[1] - srcRect.y) / srcRect.h,
          ],
        };
      }
    }
    // 终点：沿进入方向的反向（末段方向取反，即「从哪条边进入」）从目标中心打到边界
    const tgtRect = next.target?.boundId
      ? rects.get(next.target.boundId)
      : null;
    if (tgtRect && next.target) {
      const c: Pt = [tgtRect.x + tgtRect.w / 2, tgtRect.y + tgtRect.h / 2];
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const dir: Pt = [prev[0] - last[0], prev[1] - last[1]];
      const hit =
        rayToRectEdge(c, dir, tgtRect) ??
        rayToRectEdge(c, [pts[0][0] - last[0], pts[0][1] - last[1]], tgtRect);
      if (hit) {
        next.target = {
          ...next.target,
          connection: [
            (hit[0] - tgtRect.x) / tgtRect.w,
            (hit[1] - tgtRect.y) / tgtRect.h,
          ],
        };
      }
    }
    return next as T;
  });
}

// ── mermaid 流程图整齐化重排 ─────────────────────────────
//
// mermaid 的 dagre 布局在服务端 mock 文本测量下偏差明显（节点中心
// 不对齐、连线歪斜）。对 flowchart（graph/flowchart 语法且无
// subgraph）：按拓扑分层、同层对齐等距、统一节点尺寸，连线全部
// 改为横平竖直的正交折线（同层水平直线、跨层垂直直线、回边右侧
// 绕行）。其他图类型（sequence/class/subgraph）不重排。

interface FlowNode {
  id: string;
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function relayoutMermaidFlowchart<
  T extends { type: string; id: string; points?: Pt[] },
>(elements: T[], mermaid: string): T[] {
  const isFlowchart = /^\s*(?:graph|flowchart)\b/i.test(mermaid);
  if (!isFlowchart) return elements;

  const nodes = elements.filter((e) => e.type === "geometry");
  const lines = elements.filter(
    (e) =>
      e.type === "arrow-line" &&
      e.points &&
      (e as { source?: { boundId?: string } }).source?.boundId &&
      (e as { target?: { boundId?: string } }).target?.boundId,
  );
  if (nodes.length === 0 || lines.length === 0) return elements;

  // 节点原矩形
  const oldRect = new Map<
    string,
    NonNullable<ReturnType<typeof elementRect>>
  >();
  for (const n of nodes) {
    const r = elementRect(n);
    if (r) oldRect.set(n.id, r);
  }
  if (oldRect.size === 0) return elements;

  // 拓扑分层（最长路径）：先用 DFS 找出回边（成环边）并从分层中剔除，
  // 避免环上节点层级随迭代抬升；回边由连线阶段走右侧绕行
  const layerOf = new Map<string, number>();
  for (const id of oldRect.keys()) layerOf.set(id, 0);
  const edges = lines.map((l) => {
    const bound = l as unknown as {
      source: { boundId: string };
      target: { boundId: string };
    };
    return [bound.source.boundId, bound.target.boundId] as [string, string];
  });
  const adj = new Map<string, string[]>();
  for (const [s, t] of edges) {
    if (!adj.has(s)) adj.set(s, []);
    adj.get(s)!.push(t);
  }
  const dfsState = new Map<string, number>(); // 1=栈上 2=完成
  const backEdges = new Set<string>();
  const dfs = (u: string) => {
    dfsState.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      if (dfsState.get(v) === 1) backEdges.add(`${u}\u0000${v}`);
      else if (dfsState.get(v) !== 2) dfs(v);
    }
    dfsState.set(u, 2);
  };
  for (const id of oldRect.keys()) if (dfsState.get(id) !== 2) dfs(id);
  const acyclicEdges = edges.filter(
    ([s, t]) => !backEdges.has(`${s}\u0000${t}`),
  );
  for (let i = 0; i < oldRect.size; i++) {
    let changed = false;
    for (const [s, t] of acyclicEdges) {
      const next = layerOf.get(s)! + 1;
      if (next > layerOf.get(t)!) {
        layerOf.set(t, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 贴靠：未被连线引用的节点（如 doublecircle 内圈）跟随与其重叠的
  // 引用节点移动（保持原相对偏移），不独立参与布局
  const refIds = new Set(edges.flat());
  const follow = new Map<string, string>(); // orphanId -> 宿主 id
  for (const [id, r] of oldRect) {
    if (refIds.has(id)) continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let host: string | null = null;
    let best = Infinity;
    for (const [hid, hr] of oldRect) {
      if (!refIds.has(hid) || hid === id) continue;
      const d = Math.hypot(hr.x + hr.w / 2 - cx, hr.y + hr.h / 2 - cy);
      if (d < Math.max(hr.w, hr.h) && d < best) {
        best = d;
        host = hid;
      }
    }
    if (host) follow.set(id, host);
  }
  // 分组感知排序：subgraph 组框由 plait 根据子元素动态计算，移动节点后
  // 组框自动跟随；同层内按（组中心x, 原x）排序，让同组成员相邻、组框
  // 收敛成块（无组节点按原 x 与组块自然交错）
  const groupIdOf = new Map<string, string>();
  for (const el of elements) {
    if (el.type !== "geometry") continue;
    const gid = (el as { groupId?: string }).groupId;
    if (gid) groupIdOf.set(el.id, gid);
  }
  const groupAcc = new Map<string, { sum: number; n: number }>();
  for (const [id, r] of oldRect) {
    if (follow.has(id)) continue;
    const gid = groupIdOf.get(id);
    if (!gid) continue;
    const acc = groupAcc.get(gid) ?? { sum: 0, n: 0 };
    acc.sum += r.x + r.w / 2;
    acc.n++;
    groupAcc.set(gid, acc);
  }
  const sortKeyOf = (id: string): [number, number] => {
    const gid = groupIdOf.get(id);
    const acc = gid ? groupAcc.get(gid) : undefined;
    const x = oldRect.get(id)!.x;
    return acc ? [acc.sum / acc.n, x] : [x, x];
  };

  // 布局集合：引用节点 + 真孤立节点（无宿主贴靠的不独立布局）

  // 统一尺寸（同图同尺寸最整齐；下限保证文本空间）
  const W = Math.max(140, ...[...oldRect.values()].map((r) => r.w));
  const H = Math.max(60, ...[...oldRect.values()].map((r) => r.h));
  const LAYER_GAP = 80;
  const NODE_GAP = 80;

  // 分层布局：层内等距居中，层间距统一
  const byLayer = new Map<number, string[]>();
  for (const [id, layer] of layerOf) {
    if (follow.has(id)) continue;
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(id);
  }
  const placed = new Map<string, FlowNode>();
  for (const [layer, ids] of byLayer) {
    ids.sort((a, b) => {
      const [ax, ay] = sortKeyOf(a);
      const [bx, by] = sortKeyOf(b);
      return ax - bx || ay - by;
    });
    ids.forEach((id, i) => {
      const n = ids.length;
      placed.set(id, {
        id,
        layer,
        x: (i - (n - 1) / 2) * (W + NODE_GAP),
        y: layer * (H + LAYER_GAP),
        w: W,
        h: H,
      });
    });
  }

  // 更新节点 points：布局节点直接用新位置；贴靠节点跟随宿主位移
  const moved = elements.map((el) => {
    if (el.type !== "geometry") return el;
    const p = placed.get(el.id);
    if (p) {
      return {
        ...el,
        points: [
          [p.x, p.y],
          [p.x + p.w, p.y + p.h],
        ],
      } as T;
    }
    const hostId = follow.get(el.id);
    const old = oldRect.get(el.id);
    if (hostId && old) {
      const host = placed.get(hostId);
      const oldHost = oldRect.get(hostId);
      if (host && oldHost) {
        const dx = host.x - oldHost.x;
        const dy = host.y - oldHost.y;
        return {
          ...el,
          points: [
            [old.x + dx, old.y + dy],
            [old.x + old.w + dx, old.y + old.h + dy],
          ],
        } as T;
      }
    }
    return el;
  });

  // 连线全部重设为正交折线
  const relaid = moved.map((el) => {
    if (el.type !== "arrow-line") return el;
    const line = el as T & {
      source: { boundId: string; marker?: string };
      target: { boundId: string; marker?: string };
      points: Pt[];
    };
    const s = placed.get(line.source.boundId);
    const t = placed.get(line.target.boundId);
    if (!s || !t) return el;

    let points: Pt[];
    let sourceConn: [number, number];
    let targetConn: [number, number];
    const scx = s.x + s.w / 2;
    const tcx = t.x + t.w / 2;
    if (s.layer === t.layer) {
      // 同层：水平直线（相向左右边中点）
      const [l, r] = scx <= tcx ? [s, t] : [t, s];
      points = [
        [l.x + l.w, l.y + l.h / 2],
        [r.x, r.y + r.h / 2],
      ];
      sourceConn = scx <= tcx ? [1, 0.5] : [0, 0.5];
      targetConn = scx <= tcx ? [0, 0.5] : [1, 0.5];
    } else if (t.layer > s.layer) {
      // 正向跨层：源底中 → 目标顶中；x 对齐时退化为垂直直线
      const sy2 = s.y + s.h;
      if (Math.abs(scx - tcx) < 0.5) {
        points = [
          [scx, sy2],
          [tcx, t.y],
        ];
      } else {
        const midY = (sy2 + t.y) / 2;
        points = [
          [scx, sy2],
          [scx, midY],
          [tcx, midY],
          [tcx, t.y],
        ];
      }
      sourceConn = [0.5, 1];
      targetConn = [0.5, 0];
    } else {
      // 回边：右侧绕行（源右中 → 外侧 → 目标右中）
      const detourX = Math.max(s.x + s.w, t.x + t.w) + 60;
      points = [
        [s.x + s.w, s.y + s.h / 2],
        [detourX, s.y + s.h / 2],
        [detourX, t.y + t.h / 2],
        [t.x + t.w, t.y + t.h / 2],
      ];
      sourceConn = [1, 0.5];
      targetConn = [1, 0.5];
    }
    return {
      ...line,
      points,
      source: { ...line.source, connection: sourceConn },
      target: { ...line.target, connection: targetConn },
    } as T;
  });
  return relaid;
}

export function buildBookmarkCanvasElements(
  bookmarks: BookmarkCardInput[],
  links: CanvasLinkInput[],
  origin: [number, number] = [0, 0],
): Array<BookmarkCardElement | CanvasLineElement> {
  // 卡片网格布局
  const cards: BookmarkCardElement[] = bookmarks.map((b, i) => {
    const row = Math.floor(i / GRID_COLUMNS);
    const x = origin[0] + (i % GRID_COLUMNS) * (BOOKMARK_CARD_WIDTH + GRID_GAP);
    const y = origin[1] + row * (BOOKMARK_CARD_HEIGHT + GRID_GAP);
    return {
      id: `card-${b.id}`,
      type: "geometry",
      shape: "rectangle",
      bookmarkId: b.id,
      title: b.title ?? b.url,
      url: b.url,
      favicon: b.favicon ?? null,
      points: [
        [x, y],
        [x + BOOKMARK_CARD_WIDTH, y + BOOKMARK_CARD_HEIGHT],
      ],
      opacity: 1,
    };
  });

  const cardByBookmarkId = new Map(cards.map((c) => [c.bookmarkId, c]));

  return [
    ...cards,
    ...links.map((l, i): CanvasLineElement => {
      const src = cardByBookmarkId.get(l.source);
      const tgt = cardByBookmarkId.get(l.target);
      if (!src || !tgt) {
        throw new Error(
          `links[${i}] 引用了不在 bookmarkNodes 中的书签 id: ${!src ? l.source : l.target}`,
        );
      }
      const [sourceConn, targetConn] = facingConnections(src, tgt);
      return {
        id: `link-${i}`,
        type: "arrow-line",
        shape: "straight",
        source: { marker: "none", boundId: src.id, connection: sourceConn },
        target: { marker: "arrow", boundId: tgt.id, connection: targetConn },
        texts: [],
        strokeWidth: 2,
        points: [
          connectionToPoint(src, sourceConn),
          connectionToPoint(tgt, targetConn),
        ],
        opacity: 1,
      };
    }),
  ];
}

/**
 * 构建用户专属的 Agent 工具集。
 *
 * @param ctx tRPC 上下文（携带 user 认证），所有工具调用继承此身份
 */
export async function buildAgentTools(ctx: Context): Promise<ToolDefinition[]> {
  const caller = await getCaller(ctx);

  const tools: ToolDefinition[] = [
    // ── 搜索 ──────────────────────────────────────────────
    zodToToolSchema(
      "search_bookmarks",
      "在用户的书签库中搜索。支持全文和语义搜索。用于回答关于已保存内容的问题。",
      z.object({
        query: z.string().describe("搜索关键词或问题"),
        limit: z.number().default(5).describe("返回数量"),
      }),
      async (args) => {
        const result = await caller.bookmarks.searchBookmarks({
          text: args.query as string,
          sortOrder: "relevance",
        });
        const bookmarks = result.bookmarks.slice(0, args.limit as number);
        return JSON.stringify(
          bookmarks.map((b) => ({
            id: b.id,
            title: b.title,
            summary: b.summary,
            url: b.content.type === "link" ? b.content.url : undefined,
            description:
              b.content.type === "link" ? b.content.description : undefined,
          })),
        );
      },
    ),

    // ── 获取书签详情 ──────────────────────────────────────
    zodToToolSchema(
      "get_bookmark_detail",
      "获取书签的完整内容，包括标题、URL、正文、摘要。",
      z.object({
        bookmarkId: z.string().describe("书签 ID"),
      }),
      async (args) => {
        const bookmark = await caller.bookmarks.getBookmark({
          bookmarkId: args.bookmarkId as string,
          includeContent: true,
        });
        return JSON.stringify(bookmark);
      },
    ),

    // ── 创建书签 ──────────────────────────────────────────
    zodToToolSchema(
      "create_bookmark",
      "保存内容为新书签：传 url 保存网页链接（自动触发抓取和 AI 处理）；传 text 保存一段文字/文章作为笔记。url 与 text 二选一。",
      z.object({
        url: z
          .string()
          .url()
          .optional()
          .describe("要保存的 URL（与 text 二选一）"),
        text: z
          .string()
          .optional()
          .describe("要保存的文字内容或文章全文（与 url 二选一）"),
      }),
      async (args) => {
        const url = args.url as string | undefined;
        const text = args.text as string | undefined;
        if (!url && !text) {
          return JSON.stringify({
            error: "必须提供 url 或 text 参数（二选一）",
          });
        }
        const result = await caller.bookmarks.createBookmark(
          url
            ? { type: BookmarkTypes.LINK, url }
            : { type: BookmarkTypes.TEXT, text: text as string },
        );
        return JSON.stringify({
          id: result.id,
          title: result.title,
          alreadyExists: result.alreadyExists,
        });
      },
    ),

    // ── 列出所有标签 ──────────────────────────────────────
    zodToToolSchema(
      "list_tags",
      "列出用户的所有标签及其使用次数。用于了解现有标签体系。",
      z.object({
        limit: z.number().default(50).describe("返回数量"),
      }),
      async (args) => {
        const result = await caller.tags.list({
          sortBy: "usage",
          limit: args.limit as number,
        });
        return JSON.stringify(result.tags);
      },
    ),

    // ── 列出所有清单 ──────────────────────────────────────
    zodToToolSchema(
      "list_lists",
      "列出用户的所有清单（收藏夹）。用于了解分类体系。",
      z.object({}),
      async () => {
        const result = await caller.lists.list();
        return JSON.stringify(
          result.lists.map((l) => ({
            id: l.id,
            name: l.name,
            type: l.type,
          })),
        );
      },
    ),

    // ── 添加书签到清单 ────────────────────────────────────
    zodToToolSchema(
      "add_to_list",
      "将书签添加到指定清单中。用于自动归类整理。",
      z.object({
        bookmarkId: z.string().describe("书签 ID"),
        listId: z.string().describe("清单 ID"),
      }),
      async (args) => {
        await caller.lists.addToList({
          bookmarkId: args.bookmarkId as string,
          listId: args.listId as string,
        });
        return `已将书签 ${args.bookmarkId} 添加到清单 ${args.listId}`;
      },
    ),

    // ── 获取书签标签 ──────────────────────────────────────
    zodToToolSchema(
      "get_bookmark_tags",
      "获取书签上已有的标签。",
      z.object({
        bookmarkId: z.string().describe("书签 ID"),
      }),
      async (args) => {
        const bookmark = await caller.bookmarks.getBookmark({
          bookmarkId: args.bookmarkId as string,
        });
        return JSON.stringify(bookmark.tags);
      },
    ),

    // ── 给书签打标签 ──────────────────────────────────────
    zodToToolSchema(
      "attach_tag",
      "给书签添加标签。标签如果不存在会自动创建。",
      z.object({
        bookmarkId: z.string().describe("书签 ID"),
        tagName: z.string().describe("标签名称"),
      }),
      async (args) => {
        const bookmarkId = args.bookmarkId as string;
        const tagName = args.tagName as string;
        await caller.bookmarks.updateTags({
          bookmarkId,
          attach: [{ tagName }],
          detach: [],
        });
        return `已为书签 ${bookmarkId} 添加标签 "${tagName}"`;
      },
    ),

    // ── 创建画布（mermaid 流程图 + 书签卡片，可组合） ────
    zodToToolSchema(
      "create_canvas",
      "根据描述创建一个无限画布。支持两类元素：① mermaid 流程图/思维导图（AI 把用户意图转成 mermaid 语法再转换为 drawnix 元素）；② 书签卡片（把用户书签库中的书签导入为可连线卡片节点，双击可打开原链接）。两类可单独或组合使用。返回画布 ID 和编辑链接。适用场景：可视化流程/架构/思路，或梳理书签间的关系。",
      z.object({
        description: z
          .string()
          .describe(
            "对要绘制的图的描述，例如「用户下单到收货的完整流程」或「React 组件树结构」",
          ),
        title: z.string().optional().describe("画布标题，不传则用描述前 20 字"),
        mermaid: z
          .string()
          .optional()
          .describe(
            "直接提供 mermaid 语法（graph TD / mindmap / flowchart 等）。不传时由 AI 根据 description 生成。",
          ),
        bookmarkNodes: z
          .array(z.string())
          .optional()
          .describe(
            "要导入为卡片节点的书签 ID 列表（先用 search_bookmarks 等工具获取）。卡片会以网格布局摆放。",
          ),
        links: z
          .array(
            z.object({
              source: z
                .string()
                .describe("source 书签 ID（须在 bookmarkNodes 中）"),
              target: z
                .string()
                .describe("target 书签 ID（须在 bookmarkNodes 中）"),
            }),
          )
          .optional()
          .describe(
            "书签卡片之间的连线关系，source/target 均为 bookmarkNodes 中的书签 ID。",
          ),
      }),
      async (args) => {
        const description = args.description as string;
        const mermaid = ((args.mermaid as string | undefined) ?? "").trim();
        const bookmarkNodes =
          (args.bookmarkNodes as string[] | undefined) ?? [];
        const links = (args.links as CanvasLinkInput[] | undefined) ?? [];

        if (!mermaid && bookmarkNodes.length === 0) {
          return JSON.stringify({
            error:
              "缺少 mermaid 或 bookmarkNodes 参数。请提供 mermaid 语法（如 graph TD; A-->B），或提供书签 ID 列表（bookmarkNodes），或两者都提供。",
          });
        }

        let elements: Array<BookmarkCardElement | CanvasLineElement | object> =
          [];

        // ① mermaid → drawnix 元素
        if (mermaid) {
          try {
            await ensureBrowserLikeEnv();
            const { parseMermaidToDrawnix } =
              await import("@plait-board/mermaid-to-drawnix");
            elements = ((await parseMermaidToDrawnix(mermaid)).elements ??
              []) as object[];
            // ① flowchart 整齐化重排（分层对齐 + 正交直线连线）
            elements = relayoutMermaidFlowchart(
              elements as Array<{ type: string; id: string; points?: Pt[] }>,
              mermaid,
            ) as Array<BookmarkCardElement | CanvasLineElement | object>;
            // ② 修复 mermaid 线锚点越界 / 悬空（线端点不贴框）
            elements = reanchorMermaidLines(
              elements as Array<{ type: string; id: string; points?: Pt[] }>,
            ) as Array<BookmarkCardElement | CanvasLineElement | object>;
          } catch (e) {
            return JSON.stringify({
              error: `mermaid 转 drawnix 失败: ${(e as Error).message}`,
              mermaid,
            });
          }
        }

        // ② 书签卡片 + 连线
        if (bookmarkNodes.length > 0) {
          try {
            const bookmarks = await Promise.all(
              bookmarkNodes.map((id) =>
                caller.bookmarks.getBookmark({ bookmarkId: id }),
              ),
            );
            // 仅支持链接类书签（卡片依赖 URL/图标）
            for (let i = 0; i < bookmarks.length; i++) {
              if (bookmarks[i]!.content.type !== "link") {
                return JSON.stringify({
                  error: `书签 ${bookmarkNodes[i]} 不是链接类型（${bookmarks[i]!.content.type}），无法导入为卡片。请只提供网页链接类书签。`,
                });
              }
            }
            const bookmarkElements = buildBookmarkCanvasElements(
              bookmarks.map((b) => ({
                id: b.id,
                title: b.title ?? null,
                url: b.content.type === "link" ? b.content.url : "",
                favicon:
                  b.content.type === "link"
                    ? (b.content.favicon ?? null)
                    : null,
              })),
              links,
              // 有 mermaid 产物时错开摆放，避免重叠
              elements.length > 0 ? [600, 0] : [0, 0],
            );
            elements = [...elements, ...bookmarkElements];
          } catch (e) {
            return JSON.stringify({
              error: `书签卡片构造失败: ${(e as Error).message}`,
            });
          }
        }

        const title =
          (args.title as string | undefined) ?? description.slice(0, 20);
        const canvas = await caller.canvases.createCanvas({
          title,
          data: elements,
        });
        return JSON.stringify({
          id: canvas.id,
          title: canvas.title,
          editUrl: `/dashboard/canvas/${canvas.id}`,
          elementCount: elements.length,
        });
      },
    ),
  ];

  // ── 网络搜索（可选，需配置 TAVILY_API_KEY） ────────────
  if (serverConfig.tavily.apiKey) {
    tools.push(
      zodToToolSchema(
        "web_search",
        "在互联网上搜索最新信息。用于回答时事、新闻、技术文档、产品规格等用户书签库中没有的内容。返回每条结果的标题、URL 和清洁正文。",
        z.object({
          query: z.string().describe("搜索查询词"),
          maxResults: z.number().default(5).describe("返回结果数量（1-10）"),
        }),
        async (args) => {
          const apiKey = serverConfig.tavily.apiKey!;
          const resp = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              query: args.query as string,
              max_results: Math.min(Math.max(args.maxResults as number, 1), 10),
              // include_answer 让 Tavily 返回 LLM 生成的简短答案
              include_answer: true,
              // include_raw_content 太重，正文 content 已够用
              include_raw_content: false,
            }),
          });

          if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return `Tavily API 调用失败 (${resp.status}): ${text.slice(0, 200)}`;
          }

          const data = (await resp.json()) as {
            answer?: string;
            results: Array<{
              title: string;
              url: string;
              content: string;
            }>;
          };

          const parts: string[] = [];
          if (data.answer) {
            parts.push(`[Tavily 摘要] ${data.answer}`);
          }
          for (const r of data.results ?? []) {
            parts.push(`## ${r.title}\nURL: ${r.url}\n${r.content ?? ""}`);
          }
          return parts.join("\n\n---\n\n") || "未找到相关结果";
        },
      ),
    );

    tools.push(
      zodToToolSchema(
        "fetch_web_page",
        "抓取指定 URL 网页的正文（清洁文本）。用户消息中包含链接、或需要阅读某个网页才能回答时使用。默认返回前 12000 字符。",
        z.object({
          url: z.string().url().describe("要抓取的网页 URL"),
          maxLength: z
            .number()
            .default(12000)
            .describe("返回正文的最大字符数（1000-20000）"),
        }),
        async (args) => {
          const apiKey = serverConfig.tavily.apiKey!;
          const resp = await fetch("https://api.tavily.com/extract", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ urls: [args.url as string] }),
          });

          if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return `Tavily Extract 调用失败 (${resp.status}): ${text.slice(0, 200)}`;
          }

          const data = (await resp.json()) as {
            results?: Array<{ url: string; raw_content?: string | null }>;
            failed_results?: Array<{ url: string; error: string }>;
          };

          const raw = data.results?.[0]?.raw_content;
          if (!raw) {
            const reason = data.failed_results?.[0]?.error;
            return reason
              ? `网页 ${args.url} 抓取失败: ${reason}`
              : `未能从 ${args.url} 提取到正文`;
          }

          const max = Math.min(Math.max(args.maxLength as number, 1000), 20000);
          return raw.length > max
            ? `${raw.slice(0, max)}\n\n[正文过长，已截断]`
            : raw;
        },
      ),
    );
  }

  return tools;
}
