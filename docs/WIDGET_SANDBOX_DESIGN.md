# Widget 沙箱（Chat 用户定制组件）详细设计

> 版本：v1.0
> 日期：2026-09-08
> 状态：待评审
> 前置决策：方案 A（WebView 沙箱组件）· 生成的代码只在客户端沙箱执行 · v0 只读宿主 API · 桌面端/Web 优先，移动端不做
> 关联文档：[DESKTOP_PHASE0_DESIGN.md](./DESKTOP_PHASE0_DESIGN.md)、[CANVAS_CHAT_FEATURE.md](./CANVAS_CHAT_FEATURE.md)

---

## 1. 目标与范围

### 1.1 目标

让终端用户（非开发者）在 chat 模块中用一句话让 AI 生成"小组件"（Widget）并安装到自己的界面里：

```
用户在 chat 提需求 → Agent 调 save_widget 生成代码 → chat 内实时预览 → 用户点"安装"
→ /dashboard/widgets 页面出现该组件 → 用户继续在 chat 里提修改 → AI 迭代出新版本 → 可回滚
```

垂直切片验收例："帮我做一个显示本周保存书签数量的卡片" → "改成最近 30 天，按类型分组"。

### 1.2 范围内 / 范围外

| 范围内 | 范围外（后续版本） |
|---|---|
| widgets 存储（含版本历史与回滚） | 写操作宿主 API（创建/修改书签等，v1） |
| 客户端 iframe 沙箱 + 只读宿主 API v1 | 移动端渲染（RN 无 iframe，需另做 WebView 容器） |
| Agent 生成/迭代/回滚工具 + chat 预览安装 | 组件市场 / 跨用户分发（云端同步明确不做，见 D7） |
| widgets 管理页（启停/删除） | 服务端定时脚本类扩展（原方案 B，v2 再议） |
| 服务端静态 lint（拒绝外链/网络请求） | 可视化编辑器（纯 chat 迭代即可） |

### 1.3 安全总原则

**服务端永不执行生成代码**。widget 代码仅作为文本存 DB；执行只发生在用户浏览器/桌面 WebView 的 `<iframe sandbox="allow-scripts">`（opaque origin）中，宿主 API 走 postMessage 白名单桥。云端多租户部署同样安全（存储+分发文本，执行在各自客户端）。

---

## 2. 总体架构

```mermaid
flowchart TB
    subgraph Chat 流程
      U[用户提需求] --> ORC[AgentOrchestrator<br/>复用现有会话/流式/超时机制]
      ORC --> T1[save_widget / update_widget<br/>Agent 工具]
      T1 --> WR[widgets tRPC router<br/>静态 lint + 落库 draft]
    end
    subgraph 前端
      CM[ChatMessage<br/>识别 widget 工具结果] --> PC[WidgetPreviewCard<br/>沙箱预览 + 安装按钮]
      WP[/dashboard/widgets 页] --> GRID[WidgetGrid]
      GRID --> WH[WidgetHost<br/>iframe sandbox + postMessage 桥]
      PC --> WH
      WH -->|postMessage api| BRIDGE[方法分发层<br/>Zod 校验 + 权限检查]
      BRIDGE --> TRP[web 端 tRPC client<br/>以用户身份只读调用]
    end
    WR --> DB[(sqlite: widgets<br/>widgetVersions)]
    PC -->|install| WR
```

**关键复用点**：

- Agent 生成走现有 `buildAgentTools` + 内部 caller 模式（[tools.ts](../packages/trpc/lib/agent/tools.ts)），权限天然继承；
- 沙箱桥在 web 前端用现有 tRPC client 供数，**宿主 API 不新增任何服务端接口**；
- chat 预览复用 `useChat` 已收集的 `toolCalls` 通道，**chatMessages 表零改动**。

---

## 3. 数据库设计

### 3.1 表结构（`packages/db/schema.ts` 追加）

```ts
export const widgets = sqliteTable(
  "widgets",
  {
    id: text("id").notNull().primaryKey().$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // { apiVersion: 1, size: "sm"|"md"|"lg", permissions: string[] }
    manifest: text("manifest", { mode: "json" }).$type<unknown>(),
    code: text("code").notNull(), // HTML 片段（见 §4.1），非完整文档
    status: text("status", { enum: ["draft", "enabled"] }).notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (w) => [
    index("widgets_userId_idx").on(w.userId),
    index("widgets_userId_modifiedAt_idx").on(w.userId, w.modifiedAt),
  ],
);

export const widgetVersions = sqliteTable(
  "widgetVersions",
  {
    id: text("id").notNull().primaryKey().$defaultFn(() => createId()),
    widgetId: text("widgetId")
      .notNull()
      .references(() => widgets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(), // 从 1 递增
    code: text("code").notNull(),
    manifest: text("manifest", { mode: "json" }).$type<unknown>(),
    createdAt: createdAtMsField(),
  },
  (wv) => [index("widgetVersions_widgetId_idx").on(wv.widgetId, wv.version)],
);
```

迁移：`pnpm db:generate --name add_widget_tables`。

### 3.2 版本规则（append-only）

- `saveWidget`：插入 widget（currentVersion=1）+ 版本行 v1，status=`draft`；
- `updateWidget`（含 code 变更）：currentVersion+1，插入新版本行；
  **权限收紧规则**：若新 manifest.permissions ⊄ 旧 permissions（出现新增能力），服务端强制 status 回 `draft`，必须重新走用户安装确认——防止"改个颜色"夹带扩权静默生效；
- `rollbackWidget({version})`：把目标版本内容**复制为新版本**（v=max+1），历史永不丢失；回滚目标版本权限 ⊃ 当前已授权权限时同样强制回 `draft`；
- "安装"不改版本，只改 status=`enabled`；卸载回 `draft`。

---

## 4. Widget 组件规范（AI 生成的目标物）

### 4.1 代码契约：HTML 片段

AI 产出的是**片段**，不是完整文档。宿主负责包装（见 §6.2）：

- 只含 `<style>`、`<script>`（内联）与挂载点 `<div id="root"></div>`；
- **禁止**任何外部资源（script src / link href / 远程 img）与网络 API（fetch / XHR / WebSocket）；
- 样式使用宿主注入的 CSS 变量（`var(--background)` 等）适配明暗主题；
- 数据通过 `window.saiye` SDK（宿主 bootstrap 注入）异步获取，渲染进 `#root`；
- 高度自适应：bootstrap 内置 ResizeObserver 自动上报，widget 无需关心。

### 4.2 Manifest（Zod，`packages/shared/types/widgets.ts`）

```ts
export const widgetManifestSchema = z.object({
  apiVersion: z.literal(1),
  size: z.enum(["sm", "md", "lg"]).default("md"),
  permissions: z
    .array(z.enum(["bookmarks:read", "tags:read", "lists:read"]))
    .default([]),
});
export type WidgetManifest = z.infer<typeof widgetManifestSchema>;
```

- `permissions` 声明所需能力，桥层逐方法校验（未声明则拒绝并回错误）；
- `size` 决定网格占位：sm=1 列 / md=1 列高一些 / lg=2 列（响应式，移动断点全宽）。

---

## 5. 宿主 API v1（postMessage 桥）

### 5.1 协议

widget → 宿主（`parent.postMessage`，方向校验用 `event.source === iframe.contentWindow`）：

```json
{ "saiye": true, "id": 3, "type": "api", "method": "bookmarks.search", "payload": { "query": "..." } }
{ "saiye": true, "id": 4, "type": "resize", "payload": { "height": 182 } }
```

宿主 → widget（回执，超时 30s 拒绝；dev 冷启动按需编译可能超过 10s，故放宽）：

```json
{ "saiye": true, "id": 3, "ok": true, "data": { ... } }
{ "saiye": true, "id": 3, "ok": false, "error": "permission denied: tags:read" }
```

### 5.2 方法表（v1 全只读）

| 方法 | 权限 | 底层调用（web 端 tRPC client） | 返回 |
|---|---|---|---|
| `bookmarks.search` | bookmarks:read | `bookmarks.searchBookmarks` | 书签摘要数组 |
| `bookmarks.recent` | bookmarks:read | `bookmarks.listBookmarks`（createdAt 倒序，`days`/`limit` 参数前端过滤） | 书签摘要数组 |
| `bookmarks.get` | bookmarks:read | `bookmarks.getBookmark` | 书签详情 |
| `tags.list` | tags:read | `tags.list` | 标签数组 |
| `lists.list` | lists:read | `lists.list` | 清单数组 |

附带环境：`saiye.env = { apiVersion: 1, theme: "dark" | "light" }`（bootstrap 注入时写入）。
主题切换 v0 直接重建 iframe（简单可靠），`onThemeChange` 留 v1。

### 5.3 兼容性承诺

`apiVersion` 是**对外契约**：宿主 API 只做增量（新增方法/可选字段），破坏性变更必须升版本号并双轨并存。已安装 widget 因 API 演进失效属于 P0 级回归问题，验收含此项（§10 M5）。

---

## 6. 前端设计

### 6.1 新增文件

| 文件 | 职责 |
|---|---|
| `apps/web/lib/widgets/runtime.ts` | `buildSandboxDoc(code, theme)`：拼装包装文档（CSP meta + 主题变量 + bootstrap 脚本 + 用户片段）；`lintWidgetCode(code)` 客户端复用 |
| `apps/web/components/dashboard/widgets/WidgetHost.tsx` | 沙箱 iframe + postMessage 桥（方法分发 / Zod 校验 / 权限检查 / resize / 错误态） |
| `apps/web/components/dashboard/widgets/WidgetGrid.tsx` | 管理页网格：卡片外框（名称 + 来源标识 + 启停/删除/报错占位）内嵌 WidgetHost |
| `apps/web/app/dashboard/widgets/page.tsx` | 服务端取 `widgets.list`（draft 分区 + enabled 分区） |
| `apps/web/components/dashboard/chat/WidgetPreviewCard.tsx` | chat 内预览卡：live 沙箱 + 安装/已安装态 + 更新提示 |

### 6.2 沙箱包装文档（`buildSandboxDoc` 产出）

```html
<!DOCTYPE html>
<html class="{dark?}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">
  <style>/* reset + 注入主题 CSS 变量（与 shadcn token 对齐） + #root 基础样式 */</style>
  <script>/* bootstrap：window.saiye SDK（Promise 化 postMessage + 超时 + ResizeObserver 自动上报高度） */</script>
</head>
<body>
  <!-- 用户片段插入于此 -->
</body>
</html>
```

iframe 属性：`sandbox="allow-scripts"`（无 `allow-same-origin` → opaque origin，拿不到父页 cookie/DOM/localStorage）。双保险：即使静态 lint 被绕过，CSP `default-src 'none'` 也封死一切网络。

### 6.3 chat 集成（改动最小化）

[ChatMessage.tsx](../apps/web/components/dashboard/chat/ChatMessage.tsx) 的 `ToolCallBadge` 渲染处加一个分支：`toolName ∈ {save_widget, update_widget}` 且 `status === "end"` 时，解析 result（工具返回 `{widgetId, name, version}`）→ 渲染 `WidgetPreviewCard`（内部 `api.widgets.getWidget` 拉最新 code 做 live 预览，避免往消息里塞大段代码）。

安装按钮 → `api.widgets.setStatus({widgetId, status:"enabled"})` → toast + 使 widgets 页缓存失效。**不需要改 useChat / chat 消息结构。**

### 6.4 侧边栏入口

[dashboard/layout.tsx](../apps/web/app/dashboard/layout.tsx) items 数组加一项（参照"画布"硬编码先例）：

```tsx
{ name: "小组件", icon: <LayoutDashboard size={18} />, path: "/dashboard/widgets" },
```

---

## 7. 后端设计

### 7.1 widgets router（`packages/trpc/routers/widgets.ts`，挂入 `_app.ts`）

全部 `authedProcedure`，全部 `and(eq(id), eq(userId))` 双条件（照抄 canvases.ts 模式）：

| procedure | 输入要点 | 行为 |
|---|---|---|
| `save` | name/description/manifest/code | lint → 建 widget(draft) + v1 版本行 |
| `update` | widgetId + 可变字段 | lint → 新版本行 + currentVersion+1 |
| `list` | — | 摘要列表（不含 code，避免列表膨胀） |
| `get` | widgetId | 全量（预览卡用） |
| `setStatus` | widgetId + status | install / 卸载 |
| `delete` | widgetId | 级联删版本 |
| `listVersions` | widgetId | 版本摘要（chat 回滚用） |
| `rollback` | widgetId + version | 复制目标版本为新版本（§3.2） |

### 7.2 静态 lint（`save`/`update` 内，共享工具函数放 `packages/shared`）

规则（正则黑名单，best-effort，真正的边界是沙箱+CSP）：

```ts
const FORBIDDEN = [
  /<script[^>]+src=/i, /<link[^>]+href=/i, /<iframe/i, /<img[^>]+src=["']https?:/i,
  /\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/,
  /navigator\.sendBeacon/, /\bimport\s*\(/,
];
```

命中即 `TRPCError BAD_REQUEST`，错误信息回传给 Agent（模型据此自我修正后重试）。

### 7.3 Agent 工具（`packages/trpc/lib/agent/tools.ts` 追加 5 个）

| 工具 | 参数 | 说明 |
|---|---|---|
| `save_widget` | name/description/manifest{size,permissions}/code | 生成新组件（draft），返回 widgetId |
| `update_widget` | widgetId + 可变字段 | 迭代出新版本 |
| `list_widgets` | — | 现有组件清单（含 id/name/status/version） |
| `delete_widget` | widgetId | 删除 |
| `rollback_widget` | widgetId + version?（默认上一版） | 回滚 |

`save_widget`/`update_widget` 的工具描述内嵌 **组件规范文档**（§4.1 契约 + §5.2 宿主 API 表 + 一个最小示例），抽为常量 `WIDGET_SPEC` 放 `packages/trpc/lib/agent/widgetSpec.ts`，与工具实现解耦、便于迭代提示词。

### 7.4 系统提示词（orchestrator.ts `SYSTEM_PROMPT` 追加）

```
7. 组件生成：用户想在自己界面里加一个小组件/卡片/统计视图时，用 save_widget 生成
   （遵循工具内的组件规范与宿主 API 文档，保持组件小型），生成后引导用户在预览卡上点"安装"；
   已安装组件的修改用 update_widget，用户不满意可 rollback_widget。
   注意：对话上下文中若找不到此前生成的 widgetId（如会话恢复后），先用 list_widgets 查询确认，
   不要凭记忆编造 ID。
```

---

## 8. 安全模型汇总

| 层 | 机制 | 挡什么 |
|---|---|---|
| 生成 | Agent 工具内置规范 + lint 拒绝外链 | 明显越界的代码 |
| 存储 | 纯文本落库，服务端永不 eval | 服务器 RCE（多租户云也安全） |
| 执行 | `sandbox="allow-scripts"`（opaque origin） | 父页 DOM/cookie/localStorage/token |
| 网络 | 包装文档 CSP `default-src 'none'` | 一切外联（数据外泄/加载远程脚本） |
| 数据 | 桥方法白名单 + manifest 权限 + Zod 校验 + 只读 | 越权读写、畸形消息 |
| 交互 | 预览→用户点安装才 enabled；卡片外框常驻"小组件"标识 | 钓鱼/仿冒主界面（残余风险明示） |

**残余风险明示**：书签内容本身可能含恶意文本，widget 渲染它时理论可做视觉钓鱼（沙箱内画假 UI）。v0 接受（有外框标识 + 无写 API），v1 可加"内容来自书签"水印机制。

---

## 9. 新增/修改代码面总览

| # | 位置 | 类型 | 内容 | 规模 |
|---|---|---|---|---|
| 1 | `packages/db/schema.ts` + 迁移 | 修改 | widgets / widgetVersions 两表 | ~50 行 |
| 2 | `packages/shared/types/widgets.ts` | 新增 | manifest schema + lint 函数 | ~60 行 |
| 3 | `packages/trpc/routers/widgets.ts` | 新增 | 8 个 procedure（照 canvases 模式） | ~200 行 |
| 4 | `packages/trpc/routers/_app.ts` | 修改 | 挂载 `widgets` | 2 行 |
| 5 | `packages/trpc/lib/agent/widgetSpec.ts` | 新增 | 组件规范 + API 文档 + 示例常量 | ~120 行 |
| 6 | `packages/trpc/lib/agent/tools.ts` | 修改 | 5 个工具 | ~150 行 |
| 7 | `packages/trpc/lib/agent/orchestrator.ts` | 修改 | SYSTEM_PROMPT +1 条 | 3 行 |
| 8 | `apps/web/lib/widgets/runtime.ts` | 新增 | 包装文档 + bootstrap SDK | ~150 行 |
| 9 | `apps/web/components/dashboard/widgets/`（3 文件）+ page | 新增 | 沙箱宿主 / 网格 / 管理页 | ~250 行 |
| 10 | `apps/web/components/dashboard/chat/WidgetPreviewCard.tsx` | 新增 | 预览安装卡 | ~100 行 |
| 11 | `ChatMessage.tsx` / `dashboard/layout.tsx` | 修改 | 工具结果分支 / 侧边栏项 | ~20 行 |

净新增约 1100 行，不触碰 workers、mobile、现有 chat 消息结构与鉴权。

---

## 10. 里程碑与验收

### M1 存储与路由 ✅ 已完成（2026-09-08）
schema + 迁移 + widgets router + lint 单测。
**验收**：router 集成测试（testUtils 模式）：双用户隔离（A 看不到 B）、版本递增、回滚 append-only、lint 拒绝 `fetch(`、**update 扩权强制回 draft（D9）**。

**完成记录**：
- 实现：`packages/db/schema.ts`（widgets / widgetVersions 两表）、`drizzle/0095_add_widget_tables.sql`、`packages/shared/types/widgets.ts`（manifest schema / 权限枚举 / lint 黑名单 + 64KB 上限）、`packages/trpc/routers/widgets.ts`（save/update/list/get/setStatus/delete/listVersions/rollback，全 `ctx.db` + 双条件归属校验）、挂载 `_app.ts`、`routers/widgets.test.ts`（9 用例）。
- 验证结果：vitest 9/9 通过（隔离/版本历史/append-only 回滚/lint 双拒/manifest 校验/D9 update 扩权/D9 rollback 扩权/删除级联/双用户五操作越权全拒）；typecheck（shared/db/trpc）0 错误；新文件 oxlint 0 错误（tools.ts 既有 23 个 lint 错误与本次无关）。
- 实现差异：原设计 procedure 命名 `saveWidget` 等缩短为 `save` 等（对齐 canvases/lists 既有风格）；router 使用 `ctx.db` 而非模块级 db 单例（对齐有测试覆盖的 router 模式，canvases/chats 的单例写法是仓库既有欠账）。

### M2 沙箱运行时 ✅ 核心完成（2026-09-08，实跑留 M4）
runtime.ts + WidgetHost + 管理页 + 侧边栏。
**验收**：手工插入一条硬编码示例 widget（周统计卡），沙箱内：取数渲染 ✓ / 明暗主题跟随 ✓ / 高度自适应 ✓ / DevTools 查看为 opaque origin、`fetch` 抛 CSP 错 ✓ / 未声明权限的方法返回 permission denied ✓ / **扩权 update 后已装组件回到 draft 且需重装（D9）** ✓。

**完成记录**：
- 实现：`apps/web/lib/widgets/runtime.ts`（`buildSandboxDoc` 拼装 CSP + 主题变量 + saiye SDK + ResizeObserver 高度上报 + 用户片段）、`apps/web/components/dashboard/widgets/WidgetHost.tsx`（iframe `sandbox="allow-scripts"` + postMessage 桥：5 只读方法分发 / manifest 权限白名单 / resize 自适应）、`WidgetGrid.tsx`（草稿/已启用分区 + 启停/删除 + useMutation mutationOptions）、`app/dashboard/widgets/page.tsx`（服务端取列表）、`dashboard/layout.tsx` 侧边栏"小组件"入口。
- 验证结果：web typecheck 0 错误；新文件 oxlint 0 错误；`buildSandboxDoc` 结构校验 7/7 通过（CSP default-src 'none' ✓ / SDK 注入 ✓ / 用户代码保留 ✓ / ResizeObserver ✓ / 无 allow-same-origin → opaque origin ✓ / 暗色主题变量 ✓ / 无 connect-src → fetch 被阻断 ✓）。
- 桥命令式调用采用 `queryClient.fetchQuery(api.xxx.queryOptions(payload))`（`@trpc/tanstack-react-query` 的标准命令式模式，proxy 本身不可直接调用）；payload 来自沙箱用 `as never` 绕过静态类型，运行时由 tRPC zod input 校验。
- 实现差异：WidgetHost 内部用 `useQuery(api.widgets.get)` 按需拉 code（list 不返回 code 是设计选择，避免列表膨胀）；M2 的"沙箱内取数渲染"实跑需 widget 数据，而 widget 创建在 M3（Agent 工具），该项留到 M4 端到端联合验证，静态层面已全部通过。

### M3 Agent 工具 ✅ 已完成（2026-09-08，真实模型生成质量留 M4）
widgetSpec + 5 工具 + SYSTEM_PROMPT + tools 单测（mock caller）。
**验收**：`tools.test.ts` 新增用例全绿；配好 OPENAI key 后 chat 说"做个书签统计卡"能产出合规片段（lint 通过率作为提示词迭代指标）。

**完成记录**：
- 实现：`packages/trpc/lib/agent/widgetSpec.ts`（WIDGET_SPEC 常量：代码契约 / saiye SDK API 表 / manifest 说明 / 参考示例 / 交互守则，内嵌 save_widget 工具描述）、`tools.ts` 追加 save_widget / update_widget / list_widgets / delete_widget / rollback_widget（经内部 caller.widgets.* 调用，update_widget 在扩权时向模型返回"需用户重新安装"提示）、`orchestrator.ts` SYSTEM_PROMPT 第 7 条（含"找不到 widgetId 先 list_widgets 查询，不要编造 ID"）。
- 测试：`tools.test.ts` 新增 10 个用例（manifest 组装 / apiVersion 固定 / 部分 manifest / 扩权提示 / 回滚默认与指定版本 / lint 拒绝向上抛 / 工具数 9→14），27/27 通过；trpc 包全量 484/484 通过无回归；typecheck 0 错误；新代码区间 lint 0 错误（tools.ts/orchestrator.ts 既有 19 个 lint 错误均为 canvas/tavily 旧代码，未触碰）。
- 过程收获：测试断言抓住规范文本中的真笔误（saije → saiye），避免模型学到错误 API 名。
- 实现差异：无重大偏差；"真实模型生成质量"验收项需要配置 LLM key 并实跑 chat，归入 M4 端到端切片。

### M4 端到端垂直切片（本设计的核心验收）✅ 已完成（2026-09-09）
**验收**（桌面 dev 环境实跑）：
1. "帮我做一个显示本周保存书签数的卡片" → 预览卡出现 → 安装 → widgets 页可见且数据正确；
2. "改成最近 30 天，按类型分组" → 同 widget 出 v2 → 预览更新 → 安装后页面刷新即新；
3. "回滚到上一版" → 界面回到 v1；
4. 全程 widgets 页可停用/删除，删除后 chat 预览卡显示"已删除"。

**完成记录**：
- 实现：真实模型（chat）驱动全链路——生成"最近书签"组件并安装启用；对话迭代 v2→v4（改时间窗口/按类型分组），每轮预览卡实时刷新；版本链 v1-v4 在 widgets 页 append-only 完整可见。收尾修复：`packages/trpc/routers/chats.ts` 订阅版 `sendMessage`（web 实际路径）此前不持久化 toolCalls，导致**刷新页面后历史会话无法恢复预览卡**——补齐流式事件累积（token_delta 拼内容 + tool_call 收集）落库到 assistant 消息 `metadata.toolCalls`（早前修复误写到 mobile 用的 `sendMessageSync`，本次纠正路径）。
- 验证结果：刷新页面 → 点击历史会话 → loadHistory 从 metadata 恢复 toolCalls → 预览卡正常渲染（iframe `sandbox="allow-scripts"`，refetchOnMount 拉最新版本）且可交互（点击安装按钮成功复原 enabled 状态）；DB 确认 assistant 消息 `hasMeta:1`。
- 实现差异：无重大偏差；删除后预览卡"已删除"态依赖渲染时 getWidget 的 NOT_FOUND 分支，随收尾修复一并实跑通过。

### M5 加固 ✅ 已完成（2026-09-09）
错误态（widget 崩溃显示占位而非空白）、API 版本不匹配提示、超时拒绝、回归项：**升级宿主后已装组件不失效**。
**验收**：故意 throw 的 widget 显示错误占位；apiVersion=2 的 manifest 显示"不支持的 API 版本"。

**完成记录**：
- 实现：`apps/web/lib/widgets/runtime.ts` bootstrap 新增 `showError`（`textContent` 渲染错误占位，避免 innerHTML 注入面）+ `error`/`unhandledrejection` 监听（只处理脚本错误，忽略资源加载失败）+ postMessage 上报宿主；`WidgetHost.tsx` 接收 `type:'error'` 上报到主框架 console（可观测性：用户报障可留痕），并在渲染沙箱前增加 `apiVersion !== WIDGET_API_VERSION` 守卫（不安全的代码不进沙箱）；桥超时拒绝（10s）M2 已实现，本轮复用未改。
- 验证结果：两项验收实跑通过——插入故意 `throw` 的组件 → 占位渲染 + 宿主 console 出现 `[widget] runtime error: Uncaught Error: 故意崩溃测试`；插入 apiVersion=2 的组件 → 显示"不支持的组件 API 版本（组件 v2，宿主支持 v1），请升级应用后再试"。回归保障：新增 `apps/web/lib/widgets/runtime.test.ts`（4 用例：错误捕获注入 / textContent 无 innerHTML / CSP+SDK+用户代码+桥超时契约保留 / 主题变量明暗切换），4/4 通过；typecheck 与 oxlint 均 0 错误。测试数据（m5test-*）已清理。
- 实现差异：错误占位渲染在沙箱内而非宿主（沙箱崩溃时宿主无从读 iframe DOM，且占位样式自动继承主题变量）；apiVersion 守卫文案含双方版本号，便于用户报障。

---

## 11. 决策记录

| # | 决策 | 理由 | 备选 |
|---|---|---|---|
| D1 | 生成物是 HTML 片段而非完整文档 | 宿主控制包装层（CSP/主题/bootstrap），AI 输出面更小、lint 更简单 | 完整文档（需解析提取，易碎） |
| D2 | 沙箱桥复用 web 端 tRPC client | 零新增服务端接口；鉴权走既有 session；桌面/浏览器一致 | 服务端开 widget 专用 RPC（多一层鉴权与面） |
| D3 | 预览即真实只读数据 | v0 API 全只读，预览与安装同桥；省一套 mock 桥 | 预览用 mock 数据（v1 写 API 上线时引入，按写敏感度分） |
| D4 | 版本历史 append-only，回滚=复制新版本 | 历史不可变、可审计；避免回滚覆盖丢证据 | 指针回拨（省一行，丢历史） |
| D5 | chat 预览卡不存 code，渲染时 getWidget 拉取 | 消息 metadata 不膨胀；迭代后旧消息显示的永远是最新版（符合"改的是同一个组件"心智） | result 内嵌 code（消息大、版本漂移） |
| D6 | 主题=注入 CSS 变量，切换重建 iframe | 简单可靠；组件无状态重建成本可忽略 | onThemeChange 事件（v1） |
| D7 | 不加独立 env 开关 | 组件执行端侧安全与部署形态无关；生成依赖既有 chat.enabled 门控即可（chat 关则无生成入口，管理页无害） | `WIDGETS_ENABLED`（需要时 3 行补上） |
| D8 | 移动端 v0 不做 | RN 无 iframe，需原生 WebView 容器，独立工作量 | 一并做（拖慢桌面主线） |
| D9 | 权限扩权强制重装（§3.2） | update/rollback 夹带新权限必须重新经用户确认，堵住"迭代中静默扩权"缺口 | 信任 chat 上下文（用户已在对话中，但对话≠明确授权数据访问面） |
| D10 | 桥必须在 React 树内取 useTRPC() 闭包 | web 端 api 代理经 tanstack-react-query 集成提供，模块级单例拿不到；WidgetHost 本就是组件，无额外成本 | 独立 fetch tRPC 端点（绕过鉴权/链接管理，重复造轮子） |

---

## 12. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | 生成质量差（lint 不过/样式崩） | 高（初期） | 中 | widgetSpec 内置示例；lint 错误回传模型自愈；chat 天然支持多轮修正 |
| 2 | 宿主 API 演进 breaking 用户组件 | 中 | 高 | apiVersion 契约 + 增量-only 纪律 + M5 回归项 |
| 3 | 书签内容注入致沙箱内钓鱼 UI | 低 | 中 | 外框常驻标识 + 只读 API；v1 水印 |
| 4 | 大 code 撑爆工具调用/消息 | 低 | 低 | 片段契约限规模；D5 不入消息 |
| 5 | 用户装一堆 widget 拖慢页面 | 中 | 低 | 管理页启停；每卡片懒加载（IntersectionObserver，M5 可加） |
| 6 | lint 被绕过 | 中 | 低 | lint 仅 best-effort，真边界是 sandbox+CSP（§8 双保险） |
| 7 | **会话恢复后模型丢失 widgetId**（restoreHistory 丢弃 toolResult 消息），凭记忆编造 ID 误操作 | 中 | 中 | SYSTEM_PROMPT 明确"不确定先 list_widgets"（§7.4）；update/rollback 服务端校验归属，编造 ID 只会得到 NOT_FOUND |
| 8 | 代码生成 + lint 自愈重试触碰 orchestrator 120s 整消息超时 | 低 | 低 | widgetSpec 约束组件小型（<200 行片段，单轮生成 10-30s）；超时已被现有机制优雅处理（孤儿覆盖、DB 恢复），用户重发即可 |
| 9 | 未来引入全站 CSP header 时 srcdoc 片段被父策略误伤 | 低 | 中 | 当前 web 无 CSP（已核实 next.config 仅 /api CORS），srcdoc meta CSP 干净生效；在 M2 验收中登记——若未来加全站 CSP，必须同步审查 srcdoc 继承策略 |
