# Widget 写 API 与敏感度分级设计（v1）

> 版本：v1.0
> 日期：2026-09-09
> 状态：待评审
> 前置文档：[WIDGET_SANDBOX_DESIGN.md](./WIDGET_SANDBOX_DESIGN.md)（v0 只读沙箱，M1-M5 已完成）
> 前置决策继承：D1-D10 全部有效（尤其 D2 桥复用用户身份 tRPC、D3 预览即真实数据、D9 扩权强制重装）

---

## 1. 目标与范围

### 1.1 目标

让组件从"只读展示"升级为"可操作"：快速保存书签、给书签打标签、批量整理清单、清理冗余数据等。

```
用户："做一个快速保存当前想法的输入框组件" → 组件声明 bookmarks:write
→ 安装时看到"此组件可修改你的书签"并同意 → 组件内点击保存 → 真实落库
```

### 1.2 范围内 / 范围外

| 范围内 | 范围外（后续版本） |
|---|---|
| 敏感度三级模型（读 / 写 / 删）与权限扩展 | 移动端（D8 续） |
| 9 个新 SDK 方法（§4）+ 桥分发与输入窄化 | 服务端新接口（D2 续：桥仍复用用户身份 tRPC client，服务端零改动） |
| 安装时分级同意 UI + L2 运行时逐次确认 | 组件市场 / 跨用户分发（续 D7） |
| 预览态写拦截 | 写操作 toast 角标、水印（v2） |
| 宿主内存限流 + localStorage 活动审计 | 服务端审计表（见 D14） |
| WIDGET_SPEC 写 API 文档与生成守则 | tags 重命名 / lists 元数据编辑 / tags 合并 / 批量清理类接口（v1.x 增量候选，见 §4.3 负面清单） |

---

## 2. 敏感度分级模型

分级判据：**可逆性 × 爆炸半径**。用户对"组件能对我做什么"的心智模型是三档，权限词汇表与之对齐。

| 级别 | 后缀 | 语义 | 最坏情况 | 用户保障 |
|---|---|---|---|---|
| L0 读 | `:read` | 只读查询（v0 已有） | 信息暴露于组件 UI | v0 既有能力，无新增面 |
| L1 写 | `:write` | 新增数据 / 可恢复变更 | 产生垃圾数据、修改标题笔记等既有内容（无历史可回滚） | 安装时明示同意 + 宿主限流 + 活动审计 |
| L2 删 | `:delete` | 不可逆删除 | 数据丢失 | 安装时单独勾选确认 + **运行时每次操作宿主弹确认** + 限流 + 审计 |

判据边界说明：
- **归档（archived）、收藏（favourited）** 归 L1：状态可逆；
- **改标题/笔记** 虽无历史回滚，但数据仍在、可手动改回，且被限流约束在爆炸半径内 → L1（不为此增设第四级，见 D11）；
- **tags merge / deleteUnused** 是批量删除 → 不暴露（§4.3）。

---

## 3. 权限模型

### 3.1 权限枚举扩展（`packages/shared/types/widgets.ts`）

```ts
export const zWidgetPermissionSchema = z.enum([
  // L0（v0 已有）
  "bookmarks:read", "tags:read", "lists:read",
  // L1
  "bookmarks:write", "tags:write", "lists:write",
  // L2
  "bookmarks:delete", "tags:delete", "lists:delete",
]);
```

配套导出 `widgetPermissionTier(p): "read" | "write" | "delete"`（权限 → 敏感度级别，供宿主/管理页/spec 共用）。权限的人类可读文案由 web 端 i18n 词条（`widgets.perm_*`，`InstallConsentDialog` 内 `permissionLabelKey` 映射）提供，随界面语言切换。

### 3.2 与 D9（扩权强制重装）的联动

**零改动继承**：扩权判定是"新 permissions ⊄ 旧 permissions → 强制 draft + 重装"。read→write、write→delete、read→delete 均触发。v1 唯一要求：**任何 draft→enabled 且含 L1/L2 权限的转换必须经过同意对话框**（§6.1），使"重装"天然等于"重新授权"。

### 3.3 apiVersion 保持 1（不升版）

§5.3 兼容承诺允许增量（新增方法 / 可选字段 / 新权限值）：
- 旧宿主收到含写权限的 manifest：渲染正常（apiVersion 仍 1），未知权限永不匹配任何已知方法 → 写调用得到 `permission denied`，组件只读降级；
- 新宿主收到旧 manifest：行为与 v0 完全一致。
破坏性变更（改协议、删方法、改语义）才升版本。此结论作为 M5"升级宿主不破坏已装组件"回归项的扩展用例。

---

## 4. SDK 方法表（v1 新增 9 个）

### 4.1 L1 写（`bookmarks/tags/lists:write`）

| 方法 | 权限 | 底层 tRPC | 桥侧输入窄化（白名单，超出即拒） |
|---|---|---|---|
| `bookmarks.create` | bookmarks:write | `bookmarks.createBookmark` | `{ type: "link"\|"text", url?, text?, title?, note?, summary?, favourited?, archived? }`。**不放行** source / crawlPriority / precrawledArchiveId / importSessionId / createdAt |
| `bookmarks.update` | bookmarks:write | `bookmarks.updateBookmark` | `{ bookmarkId, title?, note?, summary?, favourited?, archived? }`。**不放行** url / description / author / publisher / date* / text / assetContent（防组件伪造链接元数据） |
| `bookmarks.setTags` | bookmarks:write | `bookmarks.updateTags` | `{ bookmarkId, attach: {tagId?\|tagName?}[], detach: 同左 }`（底层本就支持按名 attach） |
| `tags.create` | tags:write | `tags.create` | `{ name }` |
| `lists.create` | lists:write | `lists.create` | `{ name, description?, icon? }`。**不放行** parentId |
| `lists.addToList` | lists:write | `lists.addToList` | `{ listId, bookmarkId }` |
| `lists.removeFromList` | lists:write | `lists.removeFromList` | `{ listId, bookmarkId }` |

### 4.2 L2 删（`:delete`）

| 方法 | 权限 | 底层 tRPC | 输入 |
|---|---|---|---|
| `bookmarks.delete` | bookmarks:delete | `bookmarks.deleteBookmark` | `{ bookmarkId }` |
| `tags.delete` | tags:delete | `tags.delete` | `{ tagId }` |
| `lists.delete` | lists:delete | `lists.delete` | `{ listId }`（deleteChildren 不透传，恒 false） |

### 4.3 负面清单（v1 及可见未来不暴露）

| 能力 | 理由 |
|---|---|
| list 分享 / 邀请 / 公开（lists.edit 的 public、invitations） | 数据外溢出本机，超出手动确认可挽回范围（D17） |
| `bookmarks.recrawl` / `summarizeBookmark` | 服务端算力滥用面 |
| `tags.merge` / `tags.deleteUnused` / `lists.merge` | 批量不可逆，合并语义复杂，确认对话框无法呈现清晰摘要 |
| `updateReadingProgress` / 资产上传 / 文本正文编辑（updateBookmarkText） | 组件场景价值低，v1 保持最小面 |
| 用户 / API key / webhook / rules 等非书签域 | 与组件职责无关 |

### 4.4 协议细节

- 回执错误为**稳定前缀字符串**（与 v0 一致）：`permission denied:` / `preview_write_blocked:` / `rate_limited:` / `user_denied:` / `unknown method:` / 底层错误原文；SDK 文档列全，组件据此降级。
- **写方法超时 60s**（读 30s，已随 M5 后续加固放宽）：L2 确认对话框需要等用户点击，10s 会误杀。
- 命令式 mutation 调用（W1 已验证）：`api.<proc>.mutationOptions().mutationFn(input)`——tanstack-react-query v11.9 代理**不提供** `.mutate()`，但 `mutationOptions()` 返回的 `mutationFn` 可脱离 React 直接调用。**不使用** queryClient.fetchQuery（写操作不应进缓存）。

---

## 5. 预览态行为（写拦截）

WidgetHost 新增 `mode: "preview" | "installed"` prop（预览卡传 preview，管理页网格传 installed）：

| 级别 | 预览态行为 |
|---|---|
| L0 读 | 照旧真实数据（D3 不变） |
| L1 / L2 写 | 桥直接拒绝 `preview_write_blocked: <method>`，宿主 toast「预览模式下写操作不可用，安装后生效」 |

理由（D13）：mock 成功会误导用户以为已保存；结构化拒绝让 AI 生成的组件可 catch 并显示「安装后可用」占位，诚实且可演示交互样式。

WIDGET_SPEC 增加守则：**所有写调用必须 catch 并降级渲染（如按钮置灰 + 提示文案），预览态禁止把错误渲染成"组件坏了"样式**。

---

## 6. 用户确认流

### 6.1 安装时分级同意（新增 `InstallConsentDialog`）

触发点：**所有** draft→enabled 且 permissions 含 L1/L2 的转换——预览卡"安装"按钮、管理页启用开关统一路由到此对话框（L0-only 组件跳过，保持 v0 体验）。

```
┌─ 安装组件：「快速保存」 ─────────────────┐
│ 此组件将获得以下能力：                    │
│  • 读取你的书签（bookmarks:read）         │
│  ⚠ 修改你的书签：新建/改标题笔记/打标签/   │
│    收藏归档（bookmarks:write）            │
│  ☐ 我了解此组件可以【删除】我的书签/标签/  │
│    清单，删除后不可恢复                    │
│            [ 取消 ]  [ 信任并安装 ]       │
└──────────────────────────────────────────┘
```

- 文案来自 web 端 i18n 词条 `widgets.perm_*`（`InstallConsentDialog` 内 `permissionLabelKey` 映射，随界面语言切换），按级别分组渲染，L2 用警示样式 + **必选勾选框**（不勾选则安装按钮禁用）；
- 勾选通过后 `setStatus({status:"enabled"})`，同时把同意的权限快照写入活动日志（§7.2）。

### 6.2 L2 运行时逐次确认（新增 `WriteConfirmDialog`）

桥收到 `:delete` 方法（installed 态）→ **不立即执行**，宿主弹确认：

```
┌─ 组件请求删除 ───────────────────────────┐
│ 「清理助手」请求删除书签：                 │
│   《Vue 设计模式》（best-effort 拉取标题，  │
│    失败显示 ID 前 8 位）                  │
│            [ 拒绝 ]  [ 删除 ]            │
└──────────────────────────────────────────┘
```

- 目标摘要由**宿主**从 payload + 一次 getBookmark/tags.list/lists.list 查询派生（best-effort，失败回退 ID）；**绝不显示组件自报的描述**（不可信）；
- 允许 → 执行 mutation → 回执组件；拒绝 → 回执 `user_denied: <method>`；
- **不提供"本次不再询问"**（D12）：不可逆操作逐条确认即防批量误删的防呆设计；若实际使用反馈繁琐，v2 再加会话级信任开关。

---

## 7. 限流与审计

### 7.1 宿主内存限流（每 widget 每页面会话）

| 级别 | 窗口 | 上限 | 超限回执 |
|---|---|---|---|
| L1 写 | 60s | 60 次 | `rate_limited: <method>` + 宿主 toast「组件操作过于频繁，已限流」 |
| L2 删 | 60s | 10 次 | 同上 |

滑动窗口计数器存 WidgetHost 内存（刷新重置——与 L2 逐次确认互补：确认本身就是节流阀）。服务端另白捡 `createBookmark` 既有 30/min 限流。

### 7.2 活动审计（localStorage）

D2 架构事实：桥以用户 session 调 tRPC，**服务端无法区分组件操作与用户 UI 操作**，因此审计只能在宿主侧做（D14）。

- 存储：`localStorage["saiye:widget-activity:<widgetId>"]`，环形缓冲最近 100 条；
- 记录：`{ ts, method, tier, ok, targetSummary, deniedByUser? }`——含安装/升级时的同意快照、L2 确认结果、限流触发；
- 展示：管理页组件卡片新增「活动」入口（弹层列表），用户可回答"这组件到底改了我什么"；
- 边界：沙箱 opaque origin 改不了父页 localStorage（记录由宿主写，可信）；清浏览器数据会丢历史（已接受的限制，文档明示）。

---

## 8. Agent 侧更新（`widgetSpec.ts`）

1. SDK 表增补 §4 全部 9 方法 + 各自所需权限；
2. manifest 说明增补 6 个写权限及"按实际用到的方法声明，不要多要"（延续既有措辞）；
3. 交互守则新增：
   - 所有写调用必须 `.catch` 降级，`preview_write_blocked` 渲染"安装后可用"提示；
   - 删除类交互必须由用户显式点击触发，禁止组件加载即删、循环自动删；
   - 批量操作逐条调用并汇报进度，不假设任何批量 API。

---

## 9. 代码面清单

| # | 位置 | 类型 | 内容 |
|---|---|---|---|
| 1 | `packages/shared/types/widgets.ts` | 修改 | 权限枚举 3→9、tier/description 工具、窄化 zod schema 导出 |
| 2 | `apps/web/lib/widgets/runtime.ts` | 修改 | SDK 增 9 方法、写超时 60s |
| 3 | `apps/web/components/dashboard/widgets/WidgetHost.tsx` | 修改 | mode prop、写分发（窄化校验→预览拦截→L2 确认→限流→审计→执行） |
| 4 | `apps/web/components/dashboard/widgets/InstallConsentDialog.tsx` | 新增 | 分级同意（§6.1） |
| 5 | `apps/web/components/dashboard/widgets/WriteConfirmDialog.tsx` | 新增 | L2 运行时确认（§6.2） |
| 6 | `apps/web/components/dashboard/chat/WidgetPreviewCard.tsx` | 修改 | mode="preview"、安装按钮走同意对话框 |
| 7 | `apps/web/components/dashboard/widgets/WidgetGrid.tsx` | 修改 | 启用开关走同意对话框、「活动」入口 |
| 8 | `apps/web/lib/widgets/audit.ts` | 新增 | localStorage 环形缓冲 + 查询 |
| 9 | `packages/trpc/lib/agent/widgetSpec.ts` | 修改 | SDK 文档 + 守则（§8） |
| 10 | `apps/web/lib/widgets/runtime.test.ts` / `packages/trpc/routers/widgets.test.ts` | 修改 | 新用例（§10） |

**DB 零改动、服务端零改动。**

---

## 10. 里程碑与验收

### W1 契约层：权限扩展 + 桥写分发
权限枚举/tier/文案、窄化 schema、WidgetHost 写方法分发（暂以"全部直接执行"的桩确认接线）、SDK 9 方法。
**验收**：单测——窄化拒绝越界字段（update 带 url 被拒、create 带 source 被拒）；未声明写权限调用写方法回 permission denied；权限枚举 9 值 round-trip；既有 runtime.test.ts 全过。

### W2 确认与预览：同意对话框 + L2 确认 + 预览拦截
InstallConsentDialog（分级 + L2 必勾选）、WriteConfirmDialog（目标摘要 best-effort）、mode="preview" 写拦截 + toast。
**验收**（实跑）：生成含 write+delete 的组件 → 安装时 L2 不勾选无法安装；预览态点写按钮显示"安装后可用"非报错；installed 态删除弹确认且拒绝后组件收到 user_denied。

> ✅ 已完成（代码层，2026-09-09）：InstallConsentDialog / WriteConfirmDialog / 预览拦截 / 接线（预览卡 + 管理页）全部落地；web + shared-react typecheck、oxlint、runtime.test.ts 9/9 通过。实现差异：① 管理页草稿区也按 preview mode 渲染（比设计"网格一律 installed"更严：草稿未经同意，写一律拦截）；② 写路径改用 `useTRPCClient().mutate()`（见 §4.4 修正）；③ L2 确认对话框摘要查询挂在对话框组件内（open 时才拉取）。浏览器实跑验收待做。

### W3 限流与审计
内存限流（L1 60/min、L2 10/min）、audit.ts、管理页「活动」弹层。
**验收**：脚本连发 61 次 L1 → 第 61 次回 rate_limited 且活动日志有限流记录；活动弹层展示最近操作与同意快照。

> ✅ 已完成（代码层，2026-09-09）：`apps/web/lib/widgets/audit.ts`（活动日志 + 摘要生成，outcome 含 ok/error/denied）、`rateLimit.ts`（滑动窗口，时间注入可测）；WidgetHost 写路径统一审计（成功/失败/限流/用户拒绝）+ 桥侧限流；WidgetGrid「组件活动」面板 + 安装/停用/删除生命周期审计（安装记录权限快照）；预览卡安装同样落账。单测 24/24（rateLimit 5：60/61 与 10/11 拒绝、窗口滑动、tier/实例独立；audit 10：往返、容量 100 截断、破损降级、摘要回退）+ typecheck + oxlint 通过。实现差异：① 活动面板为管理页内折叠列表（打开时读 localStorage，非弹层/非实时）；② 浏览器实跑验收（连发 61 次、活动列表目视）待做。

### W4 端到端 + 回归
Agent 实跑两类组件：「快速保存输入框」（bookmarks.create）、「批量打标签」（setTags）；扩权重装链路；apiVersion 兼容回归。
**验收**：①「快速保存」安装后真实落库且 widgets 页可见新书签；②给既有只读组件 update 加 `bookmarks:write` → 服务端强制回 draft → 预览卡重新出现安装按钮 → 走同意对话框；③手工降级宿主权限枚举（模拟旧宿主）渲染含写权限 manifest → 正常渲染、写调用 permission denied（§3.3 回归）。

> ✅ 已完成（实跑，2026-09-09，账号 widget-e2e@test.local，组件「快速保存」aabovgp5kluggnoyx88zq3li）：
> - **① 安装落库**：widgets 页 installed 态保存 `https://example.com/w4-l2-delete` → 书签 epw9vtzqrwhhk81baw18uapu 真实落库（bookmarkLinks 可查），组件显示结果卡片 + 删除按钮。
> - **② 扩权重装全链路**：chat 内 AI 调 update_widget 加 `bookmarks:delete` → DB 确认 status 强制回 "draft"、current_version=2（widgetVersions v1/v2 双版本留存）→ chat 预览卡出现「重新安装」→ InstallConsentDialog 呈现三组权限（读取/修改/删除（不可恢复））+ L2 勾选框，未勾选时「信任并安装」disabled → 勾选安装后 status="enabled"。L2 双路径实跑：拒绝 → WriteConfirmDialog（含目标 ID + 「此确认每次删除都会出现，无法关闭」）回组件 `user_denied: bookmarks.delete` 且书签仍在；确认 → 书签删除 + 组件收到成功回执。审计面板完整记录：安装（权限快照）/新建/拒绝/删除。
> - **③ apiVersion 回归**：代码走查通过（§3.3：新权限值为枚举容错解析，未知值→无该权限，旧宿主只读降级渲染）；模拟旧宿主实跑未单独执行。
> - **验收中发现并修复 3 处缺陷**：① `tools.ts` save/update_widget 的 permissions 枚举改用 zWidgetPermissionSchema（此前 AI 传写权限字符串会被 zod 拒绝）；② `runtime.ts` SDK 回执监听器缺失（window message 不 settle callback，写调用永远 pending）→ 补监听 + runtime.test.ts 10 用例回归锚点；③ `WidgetHost.tsx` bookmarks.delete 漏 `writeInput` 赋值与拒绝路径 denied 审计（同族 tags/lists.delete 均有）→ 修复后审计条目显示真实 ID（`删除书签 #cv67bz4h`）且拒绝产生「用户拒绝」条目。lib/widgets 25 单测 + typecheck + oxlint 全过。
> - **环境教训**：dev server 重启（Turbopack full reload）会杀死 chat SSE 连接且前端无错误提示（isStreaming 卡死、按钮 disabled）——表现为"AI 无响应"，实为断流，刷新页面即恢复；与 LLM 60s 硬超时（sdkAdapter LLM_STREAM_TIMEOUT_MS）无关。
> - 测试数据已清理（example.com 测试书签清零，临时脚本删除）。

---

## 11. 决策记录（v1 新增）

| # | 决策 | 理由 | 备选 |
|---|---|---|---|
| D11 | 权限两级写后缀（`:write` / `:delete`）而非逐动作（create/update 分开） | 词汇表 3→9 已够表达风险层级；逐动作翻倍收益低，真正缓解是同意+限流+审计；安装文案可枚举具体能力弥补粒度 | `bookmarks:create` + `bookmarks:update` 分列 |
| D12 | L2 逐次运行时确认，无"不再询问" | 不可逆操作的确认疲劳恰是防批量误删；批量清理逐条确认是特性不是缺陷 | 会话级信任开关（v2 视反馈加） |
| D13 | 预览态拒绝写（结构化错误）而非 mock 成功 | 假成功误导用户（以为已保存）；AI 可据错误码生成"安装后可用"降级 UI | mock 桥假成功（v0 设计 D3 备选栏的原始设想，本设计否决） |
| D14 | 审计走宿主 localStorage，不建服务端表 | D2 桥复用用户身份，服务端无法归属操作到 widget；单用户桌面场景 localStorage 够用，且沙箱不可篡改 | widgets.reportActivity 服务端落库（多一张表 + 批量上报，收益仅跨设备） |
| D15 | apiVersion 保持 1 | 新方法/新权限值/可选 mode 均为 §5.3 允许的增量；旧宿主遇写权限 manifest 仍可只读降级渲染 | 升 v2（无破坏性变更，升版反让旧宿主误报不支持） |
| D16 | 桥侧输入窄化白名单，独立于底层 tRPC schema | 底层 schema 面向全 UI 开放（source/crawlPriority/公开分享等），组件可写面必须独立收窄；底层日后放宽不自动放大组件权限 | 直接透传底层 schema |
| D17 | 分享/邀请/公开、批量合并清理、服务端算力类入负面清单永不在桥暴露 | 数据外溢与算力滥用超出"用户逐次确认可挽回"的边界，不是确认对话框能兜住的 | 一并暴露但加确认（错误的安全感） |

---

## 12. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| 1 | 恶意/被注入的组件静默批量改标题笔记（L1 无运行时确认） | 中 | 中 | 限流约束爆炸半径（60/min）+ 活动审计可追溯 + 卸载止损；v2 可加"组件写操作 toast 留痕" |
| 2 | 书签内容 prompt injection 诱导组件执行写操作 | 中 | 中 | L2 有逐次确认闸门（用户能看到与意图不符的删除请求）；L1 危害受限流；spec 守则禁止自动触发写 |
| 3 | 确认对话框目标摘要拉取失败只显示 ID，用户盲确认 | 中 | 低 | best-effort 标题优先；未来可在卡片内联渲染目标行 |
| 4 | localStorage 审计被清浏览器数据抹掉 | 低 | 低 | 文档明示；核心防线（确认/限流/权限）不依赖审计 |
| 5 | 限流内存态刷新即重置 | 低 | 低 | L2 逐次确认天然免疫；L1 由服务端 createBookmark 限流兜一层 |
| 6 | `api.<proc>.mutate()` 命令式路径在当前 trpc/tanstack 版本不可用 | 低 | 低 | W1 首步即验证；退路 mutationOptions + useMutation（D10 同源结论） |
| 7 | 写权限组件在旧宿主（未升级客户端）上被误装后写功能"失灵"引发困惑 | 低 | 低 | permission denied 错误文案明确；升级宿主即恢复（§3.3 回归覆盖） |
