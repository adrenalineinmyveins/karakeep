# 06 业务逻辑层(@saiye/trpc)

[packages/trpc](../packages/trpc) 是全项目的**业务逻辑单一来源**:tRPC v11 + Drizzle + Zod 4。分层:`routers/`(tRPC 路由)→ `models/`(领域模型 / repo+service)→ `lib/`(横切工具);根目录提供 procedure 工厂与认证、邮件、指标支撑。REST、CLI、Workers(impersonating caller)全部复用这里的 `appRouter`。

## 1. Context 与 procedure 工厂([index.ts](../packages/trpc/index.ts))

```ts
interface Context {
  user: User | null;                 // { id, name, email, role: "admin" | "user" }
  auth?: RequestAuth;                // { type: "apiKey", keyId, scopes } | { type: "session" } | null
  db: typeof db;
  req: { ip: string | null };
}
type AuthedContext = Context & { user: User };  // 非空 user
```

- transformer:`superjson`;`errorFormatter` 统一计数指标、生产环境隐藏内部错误、ZodError 附加 `data.zodError`。
- 内部基座 `procedure` 依次叠加:demoMode 拒绝 mutation → 指标中间件(耗时/计数)→ OTel tracing。

| 工厂 | 说明 | 默认限流 |
|---|---|---|
| `publicProcedure` | 公开接口 | 60s / 1000 |
| `authedProcedure` | 需登录(`isAuthed` 中间件) | 60s / 3000 |
| `sessionProcedure` | 仅会话认证,**拒绝 API Key** | 同上 |
| `createScopedAuthedProcedure(resource)` | API Key 需对应资源 scope(query→read,其他→readwrite);session 放行 | 同上 |
| `createAdminScopedProcedure(resource)` | admin 角色 + scope 双重校验 | 同上 |

其他导出:`createCallerFactory`、`router`、`createRateLimitMiddleware`、`createEventLogMiddleware`、`emitRateLimitedEvent`。

## 2. 认证辅助([auth.ts](../packages/trpc/auth.ts))

| 函数 | 签名 / 说明 |
|---|---|
| `validatePassword` | `(email, password, db) => Promise<User>`;用户不存在或无密码时仍与 `DUMMY_PASSWORD_HASH` 做一次 bcrypt compare 抹平时序,防用户枚举;成功返回 user |
| `hashPassword` / `generatePasswordSalt` | bcrypt(10 轮)+ randomBytes(32) |
| `generateApiKey` | `(name, userId, db, scopes?)`:明文 `ak2_<keyId>_<secret>`(v2),scopes 空则归一为 full access |
| `authenticateApiKey` | `(key, db)`:v2 用 SHA-256 + `timingSafeEqual`(v1 `ak1_` 为 bcrypt);异步节流更新 `lastUsedAt`(10 分钟) |
| `regenerateApiKey` | 更新 keyId/keyHash |

> "首个用户即 admin"逻辑在 [models/users.ts](../packages/trpc/models/users.ts) 的 `User.createRaw`:`userCount === 0 ? "admin" : "user"`。

[email.ts](../packages/trpc/email.ts):nodemailer 封装(验证邮件 24h / 邀请 / 密码重置 1h / 列表协作邀请),`escapeHtml` 防注入,未配置 SMTP 时按需静默失败。[stats.ts](../packages/trpc/stats.ts):注册 Prometheus 指标(队列积压 Gauge、用户/书签/资产总量、订阅状态、tRPC 请求计数与延迟直方图)。

## 3. appRouter([routers/_app.ts](../packages/trpc/routers/_app.ts))

聚合 26 个子路由,`export type AppRouter = typeof appRouter` 是全端类型单一来源:

| 键 | 职责 | 键 | 职责 |
|---|---|---|---|
| `bookmarks` | 书签 CRUD/搜索/标签/摘要/阅读进度 | `rules` | 规则引擎规则 CRUD |
| `chats` | AI 聊天会话/流式对话/语音转写 | `invites` | 管理员邀请 |
| `memories` | Agent 长期记忆(上限 100 条,精确去重) | `publicBookmarks` | 公开列表(无鉴权) |
| `agentProfiles` | Agent 档案(openai-compatible / trae-cli) | `publicSharedAssets` | 分享资产公开读取(token) |
| `canvases` | 画布(drawnix)CRUD | `sharedAssets` | Agent 资产分享/发现/Fork |
| `widgets` | Chat 组件 + append-only 版本 + 扩权检测 | `subscriptions` | Stripe 订阅/配额/Webhook |
| `apiKeys` | API Key 管理(session 专用)+ `exchange`(邮箱密码换 key) | `config` | 客户端配置下发 |
| `users` | 注册/密码/设置/统计/邮箱验证 | `mirror` | Markdown 镜像状态/重建 |
| `lists` | 列表 CRUD/合并/RSS token/协作邀请 | `concepts` | 概念页(tag/list 锚点 AI 编译) |
| `tags` | 标签 CRUD/合并/列表 | `assets` | 资产列表/挂载/替换/卸载 |
| `prompts` | 自定义提示词 CRUD + 导入导出 | `webhooks` | Webhook CRUD |
| `admin` | 管理员统计/重爬/重索引/用户管理/连接诊断 | `feeds` | RSS 订阅源 CRUD/手动拉取 |
| `backups` | 备份列表/触发/删除 | `highlights` | 高亮 CRUD/搜索 |
| `importSessions` | 两阶段导入会话 | | |

## 4. 核心路由详解

### 4.1 bookmarks.ts([routers/bookmarks.ts](../packages/trpc/routers/bookmarks.ts))

Procedure:`createBookmark` / `updateBookmark` / `deleteBookmark` / `recrawlBookmark` / `searchBookmarks` / `getBookmarks` / `getBookmark` / `getBookmarkReadableContent` / `updateTags` / `summarizeBookmark` / `checkUrl` / `getBrokenLinks` / `updateReadingProgress` / `getReadingProgress`。

中间件:`ensureBookmarkOwnership`(仅所有者)、`ensureBookmarkAccess`(所有者或共享列表可见)。

**`createBookmark` 流程**(限流 60s/30 + 事件日志 `bookmark.create`):
1. LINK 先按 `(url, userId)` 去重(rss/import 来源幂等返回;其余走"重新保存":恢复归档/覆盖字段/置顶/重索引/`edited` webhook);
2. 事务:配额校验 → insert 主表 → 按 type 插入 bookmarkLinks / bookmarkTexts / bookmarkAssets;
3. 事务外:按类型入队(LINK → 爬取队列(高频时降级低优先级);TEXT → Embeddings 或 OpenAI tag;ASSET → AssetPreprocessing);
4. 并行:RuleEngine 事件 + 搜索重索引 + `created` webhook。

**`searchBookmarks`**:matcher(查询语法)先编译为 id 集合过滤;三种模式 —— `fts`(offset 分页)/ `semantic`(查询向量化 → 向量检索 threshold 0.6)/ `hybrid`(两源各取 100 条,`Promise.allSettled` + RRF 融合,语义侧失败降级 FTS);命中后 `Bookmark.loadMulti` 批量装载,返回 offset cursor。非 fts 模式独立限流 60s/300。

**`getBookmarks`**:keyset 游标分页(上一页末条 `{id, createdAt}`,`limit+1` 探测 hasMore),默认 20/页、上限 100。

**`summarizeBookmark`**(限流 30 分钟/100):取正文 + 自定义提示词 → `InferenceClientFactory.build().inferFromText` → 写回 summary + 重索引 + webhook。

### 4.2 其他路由要点

| 路由 | 要点 |
|---|---|
| [tags.ts](../packages/trpc/routers/tags.ts) | `list`(nameContains/attachedBy/sortBy=name\|usage\|relevance 游标分页);`merge` 迁移挂载后删源标签并批量重索引;`deleteUnused` |
| [lists.ts](../packages/trpc/routers/lists.ts) | 三级权限中间件 viewer→editor→owner;`merge`;RSS token 三件套;协作邀请全流程(邮件邀请/接受/拒绝/撤销/退出) |
| [users.ts](../packages/trpc/routers/users.ts) | `create`(public,限流 60s/3 + Turnstile + 注册开关);`changePassword`(15 分钟/5);`settings`/`updateSettings`/`updateAvatar`;邮箱验证与密码找回全套;`stats`(16 项并行统计) |
| [admin.ts](../packages/trpc/routers/admin.ts) | `backgroundJobsStats`(12 类队列汇总);`regenerateAllBookmarkEmbeddings`(keyset 分页批处理,页 1000);`checkConnections`(探测 search/vector/browser/queue 后端连通性);单书签诊断操作(groupId="admin");`forceStripeSync` |
| [chats.ts](../packages/trpc/routers/chats.ts) | `sendMessage`:tRPC subscription + async generator **流式输出**;`buildAgentTools(ctx)` 构建用户专属工具;`transcribeAudio` 语音转写;`sendMessageSync` 移动端非流式;部分内容也落库 |
| [importSessions.ts](../packages/trpc/routers/importSessions.ts) | `stageImportedBookmarks`(批 ≤50)/ `finalizeImportStaging` / pause / resume / results 过滤分页 |
| [apiKeys.ts](../packages/trpc/routers/apiKeys.ts) | 管理均 sessionProcedure(API key 不能管理 API key);`exchange` 供扩展"自制 OAuth"(需邮箱已验证) |
| [widgets.ts](../packages/trpc/routers/widgets.ts) | **扩权检测**:新版本新增权限时强制回 draft 并返回 `reInstallRequired`;`lintWidgetCode` 校验 |
| [subscriptions.ts](../packages/trpc/routers/subscriptions.ts) | `syncStripeDataToDatabase`:多订阅取 active/trialing 中 period_end 最晚者;手动 tier 不被降级;transition 计算(upgrade/downgrade/...) |
| [sharedAssets.ts](../packages/trpc/routers/sharedAssets.ts) | 分享为**快照语义**(apiKey 脱敏、源修改不影响);`fork` 复用三个 insertDraft/insertImported;发现页 keyset 分页 |

## 5. 领域模型(models/)

### 5.1 Bookmark 模型([models/bookmarks.ts](../packages/trpc/models/bookmarks.ts),核心)

- **`BareBookmark`**(轻量):`bareFromId`(查主表 + `isAllowedToAccessBookmark` 访问控制,不通过抛 NOT_FOUND 不泄露存在性);`ensureOwnership()`。
- **`Bookmark extends BareBookmark`**(完整聚合):
  - `fromId(ctx, bookmarkId, includeContent)`:带 relations 查询 + 访问控制 → `toZodSchema` 组装 `ZBookmark`(LINK 组装 url/标题/各资产 id/readerView/preferredPreview,TEXT 带 text,ASSET 带 assetType/size;tags 排序 human 在前);
  - **`loadMulti(ctx, input)`**(列表引擎):listId/tagId/rssFeedId 最多传一个;smart list 先解析为 id 集合;keyset 游标条件 `(createdAt, id)`;按过滤器选驱动表(lists/tags/rssImports join 或主表);CTE 内 `limit+1` + 外层 leftJoin 一次取全;`includeContent` 时并行读大 HTML(资产库);
  - 视图方法:`asZBookmark()`(协作者视图强制 `archived:false, favourited:false, note:null`)、`asPublicBookmark()`(公开列表脱敏)、`asReadableContent(format)`(turndown → markdown,contentVersion = sha256 指纹);
  - `delete()`:删行 → 并行(搜索索引 delete / 向量 delete / 镜像 delete / webhook "deleted")→ `cleanupAssets` 删资产文件。

### 5.2 其他模型

| 模型 | 要点 |
|---|---|
| [Tag](../packages/trpc/models/tags.ts) | `getAll`(attachedBy 用 HAVING,relevance 排序 CASE WHEN 打分);`merge`(事务迁移 + 批量重索引) |
| [List](../packages/trpc/models/lists.ts) | 抽象类 + `SmartList`/`ManualList` 多态;权限四档(owner > editor > viewer > public);公开读取用 `buildImpersonatingAuthedContext(listOwner)` 替身上下文 + 脱敏输出;SmartList.getBookmarkIds 递归解析 query(环检测,上限 30 层);`cleanupRulesAfterListDeletion` |
| [User](../packages/trpc/models/users.ts) | `createRaw`(首用户 admin;email 冲突转 BAD_REQUEST);邮箱验证/密码/删除全套(有 active 订阅禁止删号);`getStats`(16 项并行) |
| [Asset](../packages/trpc/models/assets.ts) | fromId / list(cursor+totalCount)/ attach / replace / detach / `getPublicSignedAssetUrl` |
| [Backup](../packages/trpc/models/backups.ts) | `triggerBackgroundJob` 创建记录并入队 |

### 5.3 repo + service 模式(较新代码)

用于 feeds / highlights / importSessions / webhooks:

- `*.repo.ts`:纯数据访问层,构造只拿 `DB`,无鉴权 CRUD;
- `*.service.ts`:方法第一参数是 `Actor`;**`authorize()` + `assertOwnership()` 品牌类型**(`Authorized<T>`,phantom symbol)——`get()` 返回 `Authorized<Feed>`,`update(feed: Authorized<Feed>)` 编译期强制只能传入已授权对象,"跳过检查拿到资源"不可表达。

## 6. lib/ 横切工具

| 文件 | 关键导出 / 说明 |
|---|---|
| [ruleEngine.ts](../packages/trpc/lib/ruleEngine.ts) | `RuleEngine`:`triggerOnEvent`(先轻量判断命中才入队);`doesBookmarkMatchConditions`(12 种条件,含 and/or 递归);`executeAction`(7 种动作:加/删标签、加/出列表(复用 List 模型天然触发嵌套规则)、下载整页归档、收藏、归档) |
| [search.ts](../packages/trpc/lib/search.ts) | 搜索 matcher → SQL 编译器:`getBookmarkIdsFromMatcher` 巨型 switch(tagName/listName/smart list 递归/rssFeedName/url/title/favourited/archived/date/age/type/brokenLinks/source/and/or);`intersect`/`union` |
| [searchRanking.ts](../packages/trpc/lib/searchRanking.ts) | `reciprocalRankFusion(resultLists, rankConstant=60)`:RRF 融合,忽略异质分数 |
| [actor.ts](../packages/trpc/lib/actor.ts) | `Actor` 类型、`assertOwnership(actor, resourceUserId)`、`Authorized<T>` 品牌类型 |
| [impersonate.ts](../packages/trpc/lib/impersonate.ts) | `buildImpersonatingAuthedContext(userId)`:系统替身执行读操作(公开列表/RSS/feed/import/backup worker 复用) |
| [rateLimit.ts](../packages/trpc/lib/rateLimit.ts) | `createRateLimitMiddleware(config)`:key = `ip + user + path`,超限抛 TOO_MANY_REQUESTS |
| [linkPreview.ts](../packages/trpc/lib/linkPreview.ts) | `getPreferredLinkPreview`:challenge 页 → overview;可读 → reader_view;有截图 → screenshot;兜底 overview |
| [turnstile.ts](../packages/trpc/lib/turnstile.ts) | Cloudflare 人机校验,所有失败降级不抛异常 |
| lib/agent/ | AI 子目录:`orchestrator.ts`(AgentOrchestrator:streamConversation/abortSession)、`tools.ts`(buildAgentTools)、`knowledgeRetrieval.ts`(RAG 知识注入)、`sdkAdapter.ts`/`cliAdapter.ts`(两种档案后端) |
