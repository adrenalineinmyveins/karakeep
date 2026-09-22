# Saiye Code Wiki

> 本 Wiki 基于 `/workspace` 代码库实际内容撰写,对 Saiye 项目(基于开源项目 [Karakeep](https://karakeep.app) 的独立再品牌版本)的架构、模块、关键代码与运行方式进行系统性文档化。如描述与代码不符,以代码为准。

Saiye 是一个自托管(self-hostable)的"收藏一切"(bookmark-everything)应用:保存链接、笔记、图片与 PDF,由 AI 自动打标签与摘要,并通过全文 + 语义混合搜索快速找回内容。

## 目录

| 章节 | 内容 |
|---|---|
| [01-项目概述](./01-项目概述.md) | 项目定位、功能特性、技术栈总览 |
| [02-整体架构](./02-整体架构.md) | 分层架构、核心数据流、认证机制、关键设计决策 |
| [03-仓库结构与模块职责](./03-仓库结构与模块职责.md) | Monorepo 全景:apps / packages / tooling / tools / docs |
| [04-数据库设计](./04-数据库设计.md) | `@saiye/db`:schema、迁移、表清单与设计亮点 |
| [05-API网关层](./05-API网关层.md) | `@saiye/api` Hono 应用、REST `/v1` 路由、OpenAPI 与 SDK |
| [06-业务逻辑层-tRPC](./06-业务逻辑层-tRPC.md) | `@saiye/trpc`:procedure 工厂、26 个路由、领域模型、规则引擎 |
| [07-后台任务系统](./07-后台任务系统.md) | `@saiye/workers`:队列抽象、14 条队列、15 个 worker |
| [08-Web前端](./08-Web前端.md) | `@saiye/web`:Next.js App Router、认证、组件、i18n |
| [09-共享基础库](./09-共享基础库.md) | shared / shared-react / shared-server / plugins 四个共享包 |
| [10-客户端应用](./10-客户端应用.md) | CLI / MCP / 浏览器扩展 / 移动端 / 落地页 / 桌面端 |
| [11-依赖关系](./11-依赖关系.md) | 内部包依赖图、外部依赖选型、类型单一来源 |
| [12-开发与运行指南](./12-开发与运行指南.md) | 环境搭建、常用命令、测试、Docker/K8s 部署、环境变量 |

## 阅读建议

- **快速了解项目**:01 → 02 → 03
- **深入某个模块**:04~10 按层阅读,配合源码跳转
- **上手开发/部署**:11 → 12
