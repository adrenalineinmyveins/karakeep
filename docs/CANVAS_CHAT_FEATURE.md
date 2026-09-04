# 画布（Canvas）× Chat AI 集成 — 功能文档与移动端移植评估

> 覆盖范围：画布数据模型与接口、AI 工具 `create_canvas`（mermaid 转换 / 书签节点两种模式）、
> 服务端浏览器环境模拟、部署要点、历史故障修复记录，以及移植到手机 App 的评估。

## 1. 功能概览

用户在 Chat 中用自然语言让 AI 生成"画布"——一个可编辑的关系图/流程图画布，落库后可在
Web 端打开、拖拽、编辑。支持两种生成方式：

| 模式 | 输入 | 产物 | 可编辑性 |
|------|------|------|---------|
| mermaid 转换 | mermaid 定义文本（flowchart/sequence/class 等） | drawnix 图形元素（geometry/text/arrow-line） | 全部可编辑 |
| 书签节点 | 书签 id 列表 + 连线关系 | 书签卡片元素 + 绑定连线 | 卡片可拖拽、连线自动跟随 |

mindmap 等其余 mermaid 类型按 `@plait-board/mermaid-to-drawnix` 的设计降级为 SVG 图片元素。

## 2. 数据模型

- 表：`canvases`（id / title / data / createdAt），`data` 列存元素 JSON 数组，schema 无类型白名单。
- 书签卡片元素契约（与编辑器手绘一致，见
  [withBookmarkCard.tsx](../apps/web/components/dashboard/canvas/plugins/withBookmarkCard.tsx) 的
  `createBookmarkCard`）：

```jsonc
{
  "id": "card-{bookmarkId}",
  "type": "geometry",
  "shape": "rectangle",
  "bookmarkId": "...",          // 书签卡片标记字段，前端 isBookmarkCard 识别用
  "title": "...", "url": "...", "favicon": "...",
  "points": [[x1, y1], [x2, y2]],   // 两点式，卡片尺寸 256×88
  "opacity": 1
}
```

- 连线元素契约（**字段必须齐全，缺 texts 渲染即崩**，见 §6）：

```jsonc
{
  "id": "link-{n}",
  "type": "arrow-line",
  "shape": "straight",
  "source": { "marker": "none",  "boundId": "card-xxx", "connection": [0.5, 0] },
  "target": { "marker": "arrow", "boundId": "card-yyy", "connection": [0.5, 1] },
  "texts": [],                  // 必填！@plait/draw 对 element.texts.forEach 硬解引用
  "strokeWidth": 2,
  "points": [[..], [..]],       // 仅为初始值，渲染时按 boundId+connection 重算
  "opacity": 1
}
```

- `connection` 语义：`[0.5, 0]` = 顶边中点，`[0.5, 1]` = 底边中点。卡片移动时线端自动跟随。

## 3. tRPC 接口（[canvases.ts](../packages/trpc/routers/canvases.ts)）

`canvases.createCanvas(title, data)` / `getCanvas(id)` / `listCanvases()` / `deleteCanvas(id)`。
页面 `/dashboard/canvas/[id]` 由 SSR 直连调用（不走 `/api/trpc`，日志排查时注意区别）。

## 4. AI 工具 create_canvas（[tools.ts](../packages/trpc/lib/agent/tools.ts)）

工具入参（zod 校验）：

- `title`：画布标题
- `mermaid`：可选，mermaid 定义文本 → `parseMermaidToDrawnix` 转换
- `bookmarkNodes`：可选，书签 id 数组（AI 先用 `search_bookmarks` 等工具取真实 id）
- `links`：可选，`{ sourceId, targetId }[]`，两端必须在 `bookmarkNodes` 内

执行流程：

1. `ensureBrowserLikeEnv()` 注入浏览器环境（见 §5）
2. mermaid 路径：动态 import mermaid-to-drawnix 转换为 drawnix 元素
3. 书签路径：`buildBookmarkCanvasElements()` 查库补全 title/url/favicon，
   网格布局（每行 3 张、间距 80；有 mermaid 产物时从 x=600 起），按 links 构造绑定连线
4. 两路元素合并（id 全局唯一）→ `canvases.createCanvas` 落库
5. 返回画布 id + 编辑页 URL（`/dashboard/canvas/{id}`）

错误处理：未知书签 id / 悬空 link 引用 / 非法 mermaid 语法 → 明确报错指明 id，不落库
（AI 可据此重试）。

## 5. 服务端浏览器环境模拟（jsdom）

mermaid + mermaid-to-drawnix 的依赖链在模块求值期/渲染期需要浏览器 API。服务端调用前必须
先建立 jsdom 环境再动态 import（顺序语义依赖 `serverExternalPackages`，见 §7）。
`ensureBrowserLikeEnv()` 共注入六组 mock：

| mock | 用途 |
|------|------|
| `SVGElement.prototype.getBBox` | mermaid 常规渲染 |
| `SVGElement.prototype.getComputedTextLength` | mindmap 的 d3 文本测宽（中文 14 / ASCII 8.4 估算） |
| `HTMLElement clientWidth/clientHeight`（600×400） | mindmap 的 cytoscape 布局容器尺寸 |
| `getComputedStyle` 包装 | jsdom 对 padding/margin/border 返回空串 → cytoscape parseFloat NaN，包装为 "0px" |
| `Element.getBoundingClientRect` | 降级图片尺寸：按 viewBox 近似解析 |
| `HTMLCanvasElement.getContext`（2d） | measureText 按字号估宽 + setTransform/save/restore/clearRect no-op |

## 6. 历史故障与修复（重要教训）

### 6.1 `tJ.addHook is not a function`（系统级故障）

根因链：Turbopack 把动态 import 的 mermaid-to-drawnix 提升进 server bundle → 服务启动时
（无 window）求值 → dompurify 导出空实例 → 首次 addHook 崩溃（`tJ` 是 minified 变量名）。

修复：`serverExternalPackages: ["@plait-board/mermaid-to-drawnix", "jsdom"]`
（[next.config.mjs](../apps/web/next.config.mjs)）。

### 6.2 `ERR_MODULE_NOT_FOUND: .../mermaid-to-drawnix/dist/index.js`

Turbopack standalone 对 serverExternalPackages 外部包的 tracing 有缺口：只拷 package.json
不拷 dist/。修复：[Dockerfile](../docker/Dockerfile) 显式 `COPY --from=base .../mermaid-to-drawnix/dist`。

### 6.3 打开画布即崩：连线缺 `texts` 字段（2026-08 修复）

工具早期版本构造的连线缺 `texts` / `marker` / `strokeWidth`，@plait/draw 的
`drawArrowLineMask` 对 `element.texts.forEach` **无空值保护**，打开画布渲染连线即抛
`TypeError`。修复分两层：

1. 生成器补齐字段（与编辑器手绘元素对齐）；
2. 存量坏数据用一次性脚本修 DB（给历史 arrow-line 补 `texts: []`、`marker`、`strokeWidth`）。

**结论：任何服务端构造的画布元素，字段集必须与编辑器产出的元素逐字段对齐。**
单测（tools.test.ts）已对连线契约做逐字段断言防回归。

### 6.4 其他

- Docker 构建高内存阶段 daemon RPC EOF（`error reading from server: EOF`）：
  构建前停掉全部运行容器释放 VM 内存即可规避。
- better-sqlite3 在 Windows 宿主缺原生 binding：19 个 DB 相关测试套件只能容器/CI 跑，与本仓库代码无关。
- 遗留未修：容器内 workers 进程每 ~19 秒 native 断言崩溃重启（`env != nullptr`）；chat LLM
  `400 modelCode：不存在`（模型名配置问题）。

## 7. 部署要点清单

1. `next.config.mjs` 的 `serverExternalPackages` 必须保留（顺序语义的生命线）；
2. Dockerfile 的 mermaid-to-drawnix dist COPY 必须保留；
3. 改 `tools.ts` 后需重建镜像才对容器生效；DB 存量数据可直接脚本修复无需重建。

## 8. 测试

[tools.test.ts](../packages/trpc/lib/agent/tools.test.ts) 共 6 场景：mermaid 正常/缺参/非法语法 +
书签节点正常/非链接书签/悬空 links。jsdom + mermaid 首载约 26s，正常与非法场景设 60s timeout。

---

## 9. 移植到手机 App 评估

### 9.1 现状（apps/mobile）

- 技术栈：Expo SDK 56 / RN 0.85 / expo-router（NativeTabs）/ NativeWind v4 / react-query v5 + zustand
- **Chat 前端已存在**（`components/chat/*` + `lib/useChatSync.ts`，非流式，调 `chats.*` tRPC 路由，
  与 Web 共用同一后端）——即 AI 创建画布的"指令入口"手机端已经有了
- **画布零基础**：无 drawnix/plait/skia/fabric/canvas 任何依赖与代码
- 鉴权：mobile 用 `apiKey`（Bearer header，`@saiye/shared-react` 的 TRPCSettingsProvider），
  与 Web 的 next-auth cookie 会话是两套体系

### 9.2 可移植性分层结论

| 层 | 内容 | 可行性 | 路径 |
|----|------|--------|------|
| L0 | AI 建画布（后端能力） | **零改动** | create_canvas 在服务端，mobile chat 已能触发 |
| L1 | 画布列表入口 | 小 | 新增 tRPC `canvases.list` 调用 + FlatList 页面，半天级工作量 |
| L2 | 只读渲染 | 中 | 二选一，见下 |
| L3 | 完整编辑 | 大 | WebView 复用 Web 编辑器（唯一现实路径） |

**drawnix/@plait 不能直接跑在 RN 上**——重度依赖 DOM/SVG/浏览器事件体系，且 jsdom 那套
mock 在客户端无意义。

### 9.3 L2 只读渲染的两条路线

**路线 A：WebView（推荐先做）**
`react-native-webview` 已在依赖中。加载 Web 端画布页 `/dashboard/canvas/{id}`，问题只有一个：
鉴权。Web 画布页走 cookie session，WebView 内没有。需要二选一：
- WebView 内嵌登录页让用户登一次（简单但体验一般）；
- 后端给画布页加 apiKey 查询参数支持（改一处 SSR 取 session 逻辑，体验最好）。

工作量：小～中。风险：离线不可用（需在线加载页面）。

**路线 B：react-native-svg 原生只读渲染器（适合离线场景）**
画布数据是纯 JSON（geometry 两点式 + arrow-line 绑定关系 + texts），自绘一个简化渲染器完全可行：
卡片 = `Rect` + favicon 图片 + `Text`，连线 = 两卡片锚点间的 `Line`/`Path` + 箭头三角，
平移缩放用现成的手势库（react-native-gesture-handler 已在依赖中）。不支持编辑、不支持复杂
mermaid 图形的精细还原（可降级为概览）。工作量：中。收益：离线可用（画布是单行 JSON，
react-query 的 persist-client 天然支持缓存）。

### 9.4 建议路线

1. **Phase 1**（小）：chat 消息里的工具结果识别画布链接 → 点击用 WebView 打开 Web 画布页
   （先解决 apiKey 鉴权桥接），同时加画布列表入口页；
2. **Phase 2**（中，可选）：若离线查看是刚需，再做 react-native-svg 只读渲染器；
3. **Phase 3**（大，按需）：编辑能力直接指向 WebView 方案，不做原生编辑器。

### 9.5 后端需要的配套改动（如果做 Phase 1）

- 画布页 SSR 支持 apiKey 鉴权（一个查询参数 + session 解析分支）；
- 无需动 canvases 路由和 create_canvas 工具——它们与端无关。
