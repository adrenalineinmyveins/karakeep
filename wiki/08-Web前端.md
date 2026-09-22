# 08 Web 前端(@saiye/web)

## 1. 概览

[apps/web](../apps/web) 是主应用:Next.js 16(App Router)+ React 19 + Tailwind + shadcn/ui,**同时承担前端渲染与 API 网关宿主**(catch-all 挂载 Hono)。`output: "standalone"` 便于 Docker 部署。

### 关键配置([next.config.mjs](../apps/web/next.config.mjs))

- `serverExternalPackages: ["@plait-board/mermaid-to-drawnix", "jsdom"]`:这两个包运行时绑定 `window`,打进 bundle 会得到空实例,必须保持外置;
- `/api/(.*)` 全路由 CORS 头;`typescript.ignoreBuildErrors: true`(CI 单独 typecheck);
- SVG 经 @svgr/webpack 转 React 组件;`ANALYZE=true` 启用 bundle 分析。

## 2. 路由结构(app/,App Router)

```
app/
├── layout.tsx                    # 根布局:字体、Providers、会话注入
├── page.tsx                      # 有会话 → /dashboard/bookmarks,否则 → /signin
├── api/
│   ├── [[...route]]/route.ts     # ★ catch-all:挂载 Hono(@saiye/api)
│   ├── auth/[...nextauth]/       # NextAuth 处理器
│   └── bookmarks/export/         # 书签导出(JSON / Netscape HTML)
├── dashboard/                    # 主工作区
│   ├── @modal/(.)preview/[id]    # 并行路由 + 路由拦截:列表内点击 → 模态框预览
│   ├── bookmarks/ archive/ favourites/ search/ tags/[id]/ lists/[id]/
│   ├── highlights/ canvas/[id]?/ chat/ widgets/ discover/ cleanups/
│   ├── concepts/[slug]?/ feeds/[id]/ preview/[bookmarkId]
│   └── layout.tsx                # 侧栏布局:无会话 redirect("/"),侧栏项按 serverConfig 裁剪
├── admin/                        # 管理后台(role=admin):overview/users/background_jobs/admin_tools
├── settings/                     # 设置:info/stats/subscription/ai/feeds/backups/mirror/import/
│                                 #        api-keys/broken-links/webhooks/agents/rules/assets/about
├── signin/ signup/ logout/ forgot-password/ reset-password/ verify-email/ invite/[token]/
├── reader/[bookmarkId]/          # 沉浸阅读器(独立布局)
├── public/lists/[listId]/        # 公开列表页
├── share/[token]/                # 分享链接页
└── canvas/[id]/                  # 顶层画布页
```

> **无 Edge middleware**:仓库不存在 `middleware.ts`。路由保护下沉到各受保护 `layout.tsx` 的服务端会话检查(`getServerAuthSession()`,未登录 redirect);`/api` 鉴权在 Hono catch-all 内由 `createContextFromRequest` 完成。dashboard 侧栏项按服务端配置动态裁剪(搜索项看 Search 插件是否注册、概念页看 inference 是否配置、聊天看 `chat.enabled`),并通过服务端 tRPC caller 预取 lists 与用户设置。

## 3. 服务端层(server/)

### [server/auth.ts](../apps/web/server/auth.ts) —— NextAuth 配置

- **Adapter**:`@auth/drizzle-adapter`(users/accounts/sessions/verificationTokens 表),覆写 `createUser` 走 `User.createRaw`;
- **Providers**:Credentials(邮箱+密码,登录限流 15 分钟 10 次);条件注册**微信扫码**与**自定义 OIDC**(`OAUTH_WELLKNOWN_URL`,PKCE+state);
- **Session**:JWT 策略;`jwt`/`session` 回调把 id/role 写入并恢复;
- `getServerAuthSession()`:统一会话入口;**桌面本地模式**(`SAIYE_LOCAL_MODE=true`)绕过 NextAuth,懒创建合成 admin;
- 同目录 [server/wechat.ts](../apps/web/server/wechat.ts):微信 OAuth 协议交互。

### [server/api/client.ts](../apps/web/server/api/client.ts) —— 上下文与服务端 caller

| 导出 | 职责 |
|---|---|
| `createContextFromRequest(req)` | 优先 `Authorization: Bearer` → API key 上下文(`authenticateApiKey`),失败回落 cookie 会话 —— Hono catch-all 的鉴权核心 |
| `createContext(db?, ip?)` | 基于 `getServerAuthSession()` 的标准 session 上下文 |
| `api = createCaller(createContext)` | appRouter 的服务端 caller,RSC 中直接 `api.xxx()` |

### [server/api/trpc.ts](../apps/web/server/api/trpc.ts)

`serverTrpc`:`@trpc/tanstack-react-query` 的 RSC 端查询代理(每请求级 QueryClient,staleTime 60s),用于 React Server Components 预取。

### instrumentation

[instrumentation.ts](../apps/web/instrumentation.ts) + [instrumentation.node.ts](../apps/web/instrumentation.node.ts):Node 运行时启动时 `loadAllPlugins()` + `initTracing("web")` + `initEventLogger("web")`。

## 4. 组件体系(components/)

| 分类 | 内容 |
|---|---|
| dashboard/bookmarks | BookmarkCard / BookmarksGrid / EditorCard(新建)/ LinkCard / TextCard / AssetCard / TagsEditor / EditBookmarkDialog / BulkTagModal / BulkManageListsModal / SummarizeBookmarkArea |
| dashboard/preview | BookmarkPreview / ReaderView / NoteEditor / HighlightsBox / **content-renderers/**(YouTube/X/Instagram/TikTok/Amazon 专用渲染器 + registry) |
| dashboard/canvas | CanvasEditor(基于 @plait/* 白板)+ withBookmarkCard(白板内嵌书签卡片) |
| dashboard/chat | ChatPanel / ChatInput / ChatMessage / ChatSessionList(流式) |
| dashboard 其他 | lists / tags / highlights / rules(规则构建器)/ search(autocomplete)/ header / sidebar / feeds / concepts / discover / widgets(WidgetHost 沙箱)/ BulkBookmarksAction / KeyboardShortcutsDialog / UploadDropzone |
| admin | UserList / AddUserDialog / CreateInviteDialog / BackgroundJobs / BookmarkDebugger / ServiceConnections |
| settings | AISettings / ApiKeySettings / FeedSettings / BackupSettings / ImportExport / WebhookSettings / MirrorSettings 等 |
| shared/sidebar | Sidebar / SidebarItem / MobileSidebar 通用骨架 |
| signin/signup/invite | 认证表单、OAuthAutoRedirect |
| wrapped | 年度回顾弹窗 |
| ui | shadcn/ui 40+ 基础组件 + **markdown/**(lexical 编辑器与渲染,含 toolbar 插件) |
| 其他 | theme-provider(next-themes)/ GlobalErrorLogger / DemoModeBanner / utils(BookmarkSavedToast 等) |

## 5. 状态管理与客户端层(lib/)

| 模块 | 职责 |
|---|---|
| [lib/providers.tsx](../apps/web/lib/providers.tsx) | Provider 总装:ClientConfig → UserLocalSettings → Session → QueryClient → **TRPCProvider**(subscription 走 httpSubscriptionLink、其余 httpBatchLink,superjson;支持 `?apiKey=` 注入 Bearer)→ I18next → Theme → Tooltip |
| lib/userLocalSettings/ | 基于 cookie 的本地偏好(界面语言/布局);"use server" 写操作 |
| lib/userSettings.tsx / readerSettings.tsx | 服务端用户设置 / 阅读器偏好 Context |
| lib/store/ | zustand:网格/键盘导航/排序/搜索页状态 |
| lib/hooks/ | bookmark-search、useBookmarkBulkActions、useBookmarkKeyboardNavigation、useBookmarkImport、useChat、upload-file 等 |
| lib/widgets/ | widget 沙箱运行时 + 限流 + 审计(均有测试) |
| lib/i18n/ | 见下 |

## 6. i18n 国际化

[lib/i18n/](../apps/web/lib/i18n/):i18next + react-i18next,**32 种语言**,单一命名空间 `translation`:

- `locales/<lang>/translation.json`:语言清单由 `@saiye/shared/langs` 单一来源定义;`locales.test.ts` 保证键完整性;
- `client.ts`:全局单例,`i18next-resources-to-backend` 动态 import 按需加载;
- `server.ts`:RSC 用 —— 每次调用 `createInstance()`,语言取自用户本地设置 cookie,返回 `getFixedT`;
- 语言选择不依赖 Accept-Language,存于用户本地设置 cookie;根布局据此设置 `<html lang dir>`(ar 自动 RTL)。

## 7. 关键外部依赖

next 16、react 19.2.3、next-auth v4、@trpc/* v11 + @tanstack/react-query、tailwindcss 3.4 + radix + lucide + sonner;编辑器 lexical + @plait/* + @drawnix/drawnix(白板);AI 流式 ai v6 + streamdown 系(代码/数学/mermaid);表单 react-hook-form + zod v4;状态 zustand + nuqs(URL 参数);i18next 系;@marsidev/react-turnstile。
