# 05 API 网关层(@saiye/api + open-api + sdk)

## 1. 定位与组装方式

[packages/api](../packages/api) 是 **"Hono 外壳 + tRPC 内核"**:真正的业务逻辑在 `@saiye/trpc` 的 appRouter;REST 处理器几乎全部通过 `createCallerFactory(appRouter)` 生成的服务端 caller(`c.var.api.*`)委托执行,只有 public/assets 与 upload 直接接触 db。

该包**不是独立进程**,而是被 `apps/web` 挂载到 Next.js catch-all 路由 [apps/web/app/api/[[...route]]/route.ts](../apps/web/app/api/[[...route]]/route.ts),通过 `hono/vercel` 的 `handle` 执行。tRPC Context(含 user/auth)由上游 web 注入;[index.ts](../packages/api/index.ts) 中有 ctx 存在性守卫,未注入则抛错。

### apiApp 结构(index.ts)

```
v1 子应用: /highlights /bookmarks /lists /tags /users /assets /admin /rss /backups /feeds
主 app 中间件(按序):
  loggerMiddleware + poweredBy
  → @hono/otel httpInstrumentationMiddleware(条件)
  → cors({ origin: "*", allowHeaders: [Authorization, Content-Type] })
  → registerMetrics(Prometheus 请求指标)
  → ctx 存在性守卫
  → trpcAdapter(tRPC 错误 → HTTP 错误)
顶层路由: /health /version /trpc /v1 /assets /public /metrics /webhooks
```

## 2. 中间件(middlewares/)

| 文件 | 关键导出 | 职责 |
|---|---|---|
| [auth.ts](../packages/api/middlewares/auth.ts) | `createCaller`、`unauthedMiddleware`、`authMiddleware`、`adminAuthMiddleware` | `createCaller = createCallerFactory(appRouter)`:REST 复用 tRPC 的服务端 caller。三个中间件区分 未登录(仅要求 ctx)/ 登录(要求 ctx.user)/ admin(要求 role=admin),均设置 `c.var.api` |
| [apiKeyScopes.ts](../packages/api/middlewares/apiKeyScopes.ts) | `apiKeyScopeMiddleware(resource, access)` | 仅当 `auth.type === "apiKey"` 时校验 scope(read/readwrite);session 直接放行;不满足抛 403 |
| [rateLimit.ts](../packages/api/middlewares/rateLimit.ts) | `createRateLimitMiddleware(config)` | 限流键 `${ip}${":user:"+userId}:${name}`;超限抛 429;限流功能未启用时直接放行 |
| [trpcAdapter.ts](../packages/api/middlewares/trpcAdapter.ts) | `trpcAdapter`、`trpcCodeToHttpCode` | tRPC 错误码 → HTTP 状态映射(400/401/403/404/408/413/429/500...);生产环境隐藏 INTERNAL_SERVER_ERROR 细节 |

## 3. REST 路由清单(routes/)

| 文件 | 挂载点 / 鉴权 | 端点摘要 |
|---|---|---|
| [bookmarks.ts](../packages/api/routes/bookmarks.ts)(最大,438 行) | `/v1/bookmarks` / auth | `GET /`(分页 + favourited/archived 过滤)、`POST /`(创建,已存在返回 200 否则 201)、`GET /search`(q + offset cursor + searchMode)、`GET /check-url`、`POST /singlefile`(SingleFile 扩展上传:scope 校验 + ifexists 五种策略 skip/overwrite/overwrite-recrawl/append/append-recrawl)、`GET /:id/content`(可读内容流式分页:format=markdown/text、base64url cursor、contentVersion 变化返回 409、ETag)、`GET/PATCH/DELETE /:id`、`GET /:id/lists|highlights`、`POST/PUT/DELETE /:id/assets`、`POST/DELETE /:id/tags`、`POST /:id/summarize` |
| [assets.ts](../packages/api/routes/assets.ts) | `/v1/assets` + 顶层 `/assets` / auth | `POST /`(上传:scope readwrite + 限流 30/分 + zValidator form)、`GET /:id/signed-url`、`GET /:id`(流式输出 + Range 支持) |
| [lists.ts](../packages/api/routes/lists.ts) | `/v1/lists` / auth | CRUD + `GET /:id/bookmarks` + `PUT/DELETE /:id/bookmarks/:bookmarkId` |
| [tags.ts](../packages/api/routes/tags.ts) | `/v1/tags` / auth | CRUD + `GET /:id/bookmarks`;cursor 为 base64url JSON |
| [highlights.ts](../packages/api/routes/highlights.ts) | `/v1/highlights` / auth | CRUD(DELETE 返回被删对象) |
| [feeds.ts](../packages/api/routes/feeds.ts) | `/v1/feeds` / auth | CRUD + `POST /:id/fetch`(立即抓取,204) |
| [backups.ts](../packages/api/routes/backups.ts) | `/v1/backups` / auth | list / trigger / get / `GET /:id/download`(302 → 签名资产 URL)/ delete |
| [users.ts](../packages/api/routes/users.ts) | `/v1/users` / auth | `GET /me`(whoami)、`GET /me/stats` |
| [admin.ts](../packages/api/routes/admin.ts) | `/v1/admin` / adminAuth | `PUT /users/:userId`、`POST /jobs/trigger/recrawl|reindex|inference` |
| [rss.ts](../packages/api/routes/rss.ts) | `/v1/rss` / unauthed | `GET /lists/:listId`:公开列表免 token / 私有列表校验 rssToken,输出 RSS XML |
| [public/assets.ts](../packages/api/routes/public/assets.ts) | `/public/assets` / unauthed | `GET /:assetId?token=`:HMAC 签名 token 验签后直接查库供资产,无需登录 |
| [trpc.ts](../packages/api/routes/trpc.ts) | `/trpc` | `@hono/trpc-server` 挂载 appRouter,复用上游注入的 ctx |
| [webhooks.ts](../packages/api/routes/webhooks.ts) | `/webhooks` | `POST /stripe`:验签后经 caller 调 `subscriptions.handleWebhook` |
| [health.ts](../packages/api/routes/health.ts) / [version.ts](../packages/api/routes/version.ts) | 无认证 | 健康检查 / 版本 |
| [metrics.ts](../packages/api/routes/metrics.ts) | `/metrics` | Prometheus 指标(bearerAuth 保护,前缀 `saiye_`,HMR 防重) |

## 4. 工具模块(utils/)

| 文件 | 职责 |
|---|---|
| [assets.ts](../packages/api/utils/assets.ts) | `serveAsset(c, assetId, userId)`:Content-Type + nosniff + 严格 sandbox CSP + 不可变缓存 + Range(206)+ 流式输出 |
| [upload.ts](../packages/api/utils/upload.ts) | `uploadAsset(user, db, formData)`:file-type 嗅探 MIME、类型白名单、大小限制(413)、`QuotaService.checkStorageQuota`(403)、临时文件 → insert assets → 落盘 |
| [pagination.ts](../packages/api/utils/pagination.ts) | `zPagination`(cursor 格式 `"id_ISODate"`)与 `adaptPagination`(内部 cursor 对象 → 字符串) |
| [readableContent.ts](../packages/api/utils/readableContent.ts) | `chunkReadableContent`:按段落边界(`\n\n` 优先)分块,base64url cursor,支撑 `GET /bookmarks/:id/content` |
| [rss.ts](../packages/api/utils/rss.ts) | `toRSS`:生成 RSS XML,过滤不安全 URL scheme |
| [types.ts](../packages/api/utils/types.ts) | `zStringBool`、includeContent / sortOrder / searchMode 查询参数 schema |

## 5. OpenAPI 规范生成(@saiye/open-api)

[index.ts](../packages/open-api/index.ts) 汇总 10 个子 registry(common/bookmarks/lists/tags/highlights/user/assets/admin/backups/feeds),经 `OpenApiGeneratorV3` 产出 OpenAPI 3.0 文档:

- 所有请求/响应 schema **复用 `@saiye/shared/types/*` 的 Zod schema(单一事实来源)**;
- 产物 [saiye-openapi-spec.json](../packages/open-api/saiye-openapi-spec.json);
- `node index.ts` 生成、`node index.ts check` 做 CI 漂移校验(不一致 exit 1);
- 该 JSON 同时被 Docusaurus 的 openapi-docs 插件消费,自动生成文档站的 API 参考。

## 6. 官方 SDK(@saiye/sdk)

[packages/sdk](../packages/sdk) 极薄:用 `openapi-fetch` + 由 OpenAPI 规范生成的类型(`saiye-api.d.ts`)导出类型化客户端:

```ts
import createSaiyeClient from "@saiye/sdk";
const client = createSaiyeClient({
  baseUrl: addr + "/api/v1/",
  headers: { authorization: `Bearer ${apiKey}` },
});
const { data } = await client.GET("/bookmarks/search", { params: { query: { q } } });
```

不手写资源方法,按路径调用即自动获得请求/响应类型。**CLI 以 tRPC 为主、REST 为辅;MCP 与 compare-models 工具完全基于该 SDK**。

## 7. 分页约定

REST 层 cursor 为字符串 `"id_ISODate"`(内部转 `{ id, createdAt }` 对象);tRPC 层 `zCursorV2` 为判别联合;搜索接口用 offset 型 cursor `{ ver: 1, offset }`。每页默认 20、上限 100(`MAX_NUM_BOOKMARKS_PER_PAGE`)。
