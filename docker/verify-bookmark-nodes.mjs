/**
 * create_canvas 新参数（bookmarkNodes + links）构造逻辑的验证脚本
 *
 * 背景：当前 create_canvas 只走 mermaid 转换管线。本脚本模拟即将写入
 * tools.ts 的新参数处理逻辑——按书签 id 构造 BookmarkCardElement（前端
 * withBookmarkCard.tsx 的卡片契约）+ arrow-line 绑定连线，并与 mermaid
 * 产物合并落库。验证数据形状能被前端识别、连线无悬空、无 id 冲突。
 *
 * 运行：node docker/verify-bookmark-nodes.mjs（纯本地，无 DB/浏览器依赖）
 */

import assert from "node:assert/strict";

// ── 前端契约常量（与 withBookmarkCard.tsx 保持一致） ──────────────────
const CARD_WIDTH = 256;
const CARD_HEIGHT = 88;

// ── mock 书签库（真实实现走 caller.bookmarks.getBookmark 补全数据） ──
const bookmarkDb = new Map([
  [
    "bm-1",
    {
      id: "bm-1",
      title: "Next.js 文档",
      url: "https://nextjs.org/docs",
      favicon: "https://nextjs.org/favicon.ico",
    },
  ],
  [
    "bm-2",
    {
      id: "bm-2",
      title: "Drizzle ORM",
      url: "https://orm.drizzle.team",
      favicon: null,
    },
  ],
  [
    "bm-3",
    {
      id: "bm-3",
      title: "tRPC 文档",
      url: "https://trpc.io/docs",
      favicon: "https://trpc.io/favicon.ico",
    },
  ],
]);

// ── 新参数处理逻辑草案（将来写入 tools.ts 的核心部分） ────────────────
/**
 * 按书签 id 构造卡片 + 绑定连线。
 * @param bookmarkIds 书签 id 列表（查库补全 title/url/favicon）
 * @param links 书签 id 对，如 [{ source: "bm-1", target: "bm-2" }]
 * @param origin 网格布局左上角（mermaid 元素占左半区时往右挪）
 */
function buildBookmarkElements(bookmarkIds, links, origin = [0, 0]) {
  // 1. 查库，id 不存在直接报错（不能静默丢弃——AI 需要知道哪个 id 错了）
  const bookmarks = bookmarkIds.map((id) => {
    const b = bookmarkDb.get(id);
    if (!b) throw new Error(`书签不存在: ${id}`);
    return b;
  });

  // 2. 网格布局：每行 3 张卡，间距 = 卡片尺寸 + 80 留白
  const GAP = 80;
  const COLS = 3;
  const cellW = CARD_WIDTH + GAP;
  const cellH = CARD_HEIGHT + GAP;

  const cards = bookmarks.map((b, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = origin[0] + col * cellW;
    const y = origin[1] + row * cellH;
    return {
      id: `card-${b.id}`,
      type: "geometry",
      shape: "rectangle",
      // 书签标记字段：前端 isBookmarkCard 靠 bookmarkId 从 geometry 中识别
      bookmarkId: b.id,
      title: b.title,
      url: b.url,
      favicon: b.favicon ?? null,
      // geometry 两点式约定：[左上, 右下]
      points: [
        [x, y],
        [x + CARD_WIDTH, y + CARD_HEIGHT],
      ],
      opacity: 1,
    };
  });

  const cardById = new Map(cards.map((c) => [c.bookmarkId, c]));

  // 3. 连线：boundId 绑定卡片，渲染时端点按 connection（边框比例点）动态重算
  const lines = links.map((l, i) => {
    const src = cardById.get(l.source);
    const tgt = cardById.get(l.target);
    if (!src || !tgt) {
      throw new Error(
        `link[${i}] 引用了不在 bookmarkNodes 中的 id: ${!src ? l.source : l.target}`,
      );
    }
    const srcCenter = [
      (src.points[0][0] + src.points[1][0]) / 2,
      (src.points[0][1] + src.points[1][1]) / 2,
    ];
    const tgtCenter = [
      (tgt.points[0][0] + tgt.points[1][0]) / 2,
      (tgt.points[0][1] + tgt.points[1][1]) / 2,
    ];
    return {
      id: `link-${i}`,
      type: "arrow-line",
      shape: "straight",
      // [0.5, 0] = 顶边中点，[0.5, 1] = 底边中点
      source: { boundId: src.id, connection: [0.5, 0] },
      target: { boundId: tgt.id, connection: [0.5, 1] },
      // points 仅为初始值，渲染时按 boundId + connection 重算
      points: [srcCenter, tgtCenter],
      opacity: 1,
    };
  });

  return [...cards, ...lines];
}

// ── 断言工具 ──────────────────────────────────────────────────────────
const isBookmarkCardEquivalent = (el) =>
  el.type === "geometry" && !!el.bookmarkId; // 前端 isBookmarkCard 的判定本质

const rectOf = (card) => ({
  x: card.points[0][0],
  y: card.points[0][1],
  w: card.points[1][0] - card.points[0][0],
  h: card.points[1][1] - card.points[0][1],
});

// ── mock mermaid 产物（真实流程来自 parseMermaidToDrawnix） ───────────
const mermaidElements = [
  {
    id: "mermaid-geo-1",
    type: "geometry",
    shape: "rectangle",
    points: [
      [10, 10],
      [110, 50],
    ],
    opacity: 1,
    text: { type: "paragraph", children: [{ text: "填写邮箱" }] },
  },
  {
    id: "mermaid-line-1",
    type: "arrow-line",
    shape: "straight",
    source: { connection: [0.5, 1] },
    target: { connection: [0.5, 0] },
    points: [
      [60, 50],
      [60, 100],
    ],
    opacity: 1,
  },
];

// ══════════════════════════════════════════════════════════════════════
// 场景 1：正常构造（3 书签 + 2 连线），与 mermaid 产物合并落库
// ══════════════════════════════════════════════════════════════════════
{
  // mermaid 元素占左半区，书签网格从 x=600 起，避免重叠
  const bookmarkElements = buildBookmarkElements(
    ["bm-1", "bm-2", "bm-3"],
    [
      { source: "bm-1", target: "bm-2" },
      { source: "bm-2", target: "bm-3" },
    ],
    [600, 0],
  );

  const data = [...mermaidElements, ...bookmarkElements];

  // 1a. 卡片结构可被前端识别
  const cards = data.filter(isBookmarkCardEquivalent);
  assert.equal(cards.length, 3, "应识别出 3 张书签卡片");
  for (const c of cards) {
    assert.ok(c.id && c.title && c.url, "卡片必须带 id/title/url");
    assert.equal(typeof c.bookmarkId, "string", "bookmarkId 必须存在");
    const r = rectOf(c);
    assert.equal(r.w, CARD_WIDTH, "卡片宽度应为 256");
    assert.equal(r.h, CARD_HEIGHT, "卡片高度应为 88");
  }

  // 1b. id 全局唯一（与 mermaid 产物合并后无冲突）
  const ids = data.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "元素 id 必须全局唯一");

  // 1c. 连线结构正确、无悬空（前端对悬空线有兜底清理，但落库数据本身应干净）
  const lines = data.filter((e) => e.type === "arrow-line");
  assert.equal(lines.length, 3, "共 3 条连线（mermaid 1 + 书签 2）");
  const bookmarkLines = lines.filter((l) => l.source.boundId);
  const cardIds = new Set(cards.map((c) => c.id));
  for (const l of bookmarkLines) {
    assert.ok(cardIds.has(l.source.boundId), "source.boundId 必须指向存在的卡片");
    assert.ok(cardIds.has(l.target.boundId), "target.boundId 必须指向存在的卡片");
    assert.deepEqual(l.source.connection, [0.5, 0], "connection 应为顶边中点");
    assert.deepEqual(l.target.connection, [0.5, 1], "connection 应为底边中点");
  }

  // 1d. 卡片之间无重叠（网格间隔 80）
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = rectOf(cards[i]);
      const b = rectOf(cards[j]);
      const overlap =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `卡片 ${cards[i].id} 与 ${cards[j].id} 不应重叠`);
    }
  }

  // 1e. 落库（mock createCanvas，验证收到的 data 形状）
  const inserted = mockCreateCanvas({ title: "架构图", data });
  assert.equal(inserted.data.length, 7, "落库元素共 7 个（2 mermaid + 3 卡 + 2 线）");
  console.log("场景 1 通过：3 卡片 + 2 连线构造正确，与 mermaid 产物合并落库");
  console.log(JSON.stringify(bookmarkElements, null, 2).slice(0, 600) + "\n...");
}

// ══════════════════════════════════════════════════════════════════════
// 场景 2：bookmarkNodes 为空 / links 引用未知 id → 明确报错
// ══════════════════════════════════════════════════════════════════════
{
  assert.throws(
    () => buildBookmarkElements(["bm-1", "bm-404"], []),
    /书签不存在: bm-404/,
    "未知书签 id 应报错",
  );
  assert.throws(
    () => buildBookmarkElements(["bm-1"], [{ source: "bm-1", target: "bm-99" }]),
    /不在 bookmarkNodes 中的 id/,
    "link 引用未列出书签应报错（避免悬空线落库）",
  );
  const empty = buildBookmarkElements([], []);
  assert.deepEqual(empty, [], "空输入产出空数组");
  console.log("场景 2 通过：非法输入均报错，不产生悬空数据");
}

function mockCreateCanvas({ title, data }) {
  return { id: "canvas-test", title, data };
}

console.log("\n全部场景通过 ✓");
