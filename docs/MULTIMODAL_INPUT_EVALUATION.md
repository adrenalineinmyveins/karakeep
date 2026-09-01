# 多模态输入需求评估文档（URL / 文字 / 文章 / 语音）

> 版本：v0.2（含 ASR 选型展开 + Chat 附件协议细化）｜范围：所有输入入口｜平台：Web + Mobile｜
> 语音：转文字输入 + 音频收藏双形态。
>
> 代码引用基于评估时的仓库快照，行号可能随开发漂移，以文件为准。

## 1. 需求背景与目标

将所有输入入口从"以 URL 为主"升级为统一多模态输入：

| 输入形态 | 含义 |
|---|---|
| URL | 链接收藏；Chat 中粘贴 URL 自动抓取正文进入对话上下文 |
| 文字 | 短文本笔记 / 对话消息 |
| 文章 | 长文本粘贴，可收藏、可作为对话上下文 |
| 语音 | ① 语音转文字后输入（说话代替打字）② 音频文件作为内容收藏，后台转录生成可搜索文本 |

**非目标**：视频文件收藏、实时语音对话（voice mode）、浏览器扩展端、实时流式转写（边说边出字，见 §5.7）。

## 2. 现状盘点（代码事实）

### 2.1 输入入口能力矩阵

| 入口 | URL | 文字 | 文章 | 语音转文字 | 音频文件 |
|---|---|---|---|---|---|
| Web 收藏编辑器 [EditorCard.tsx](../apps/web/components/dashboard/bookmarks/EditorCard.tsx) | 有（单个/多个，`tryToImportUrls`） | 有 | 有（存为 TEXT 书签） | 无 | 无（仅图片粘贴） |
| Mobile 新书签页 [new.tsx](../apps/mobile/app/dashboard/bookmarks/new.tsx) | 有 | 有 | 有 | 无 | 无 |
| Web Chat 输入 [ChatInput.tsx](../apps/web/components/dashboard/chat/ChatInput.tsx) | 弱（仅纯文本传递） | 有 | 弱（直进 prompt） | 无 | 无 |
| Mobile Chat 输入 | 弱（同上） | 有 | 弱 | 无 | 无 |
| Agent 工具 `create_bookmark` [tools.ts](../packages/trpc/lib/agent/tools.ts) | 有（入参 `z.string().url()`） | 无 | 无 | — | — |

### 2.2 基础设施差距

| 设施 | 现状 | 差距 |
|---|---|---|
| 资产类型白名单 [assetdb.ts](../packages/shared/assetdb.ts) | 上传允许图片/视频/PDF/HTML；**书签级资产仅 image/pdf** | 无任何 `audio/*` |
| 推理客户端 [inference.ts](../packages/shared/inference.ts) | 仅 `inferFromText` / `inferFromImage`；工厂支持 OpenAI（含 baseURL/proxy）→ Ollama | 缺转录方法 |
| Workers | 图片 OCR、PDF 解析、视频下载、摘要/打标/嵌入 | 无音频转录 job（上游 Karakeep 有 `videoWorker` 式的转录设计，本 fork 未包含） |
| Chat 数据模型 [schema.ts](../packages/db/schema.ts) | `chatMessages`：`role` + `content` 纯文本，**已有 `metadata` JSON 列** | 附件挂载的天然扩展点 |
| 资产上传/鉴权 | `POST /api/assets`（30 req/min 限频 + 存储配额）；读取走 `ensureCanView` + 1h 签名 URL | 可直接复用，无需新建 |

## 3. 需求拆解

| 编号 | 需求 | 依赖 |
|---|---|---|
| R1 | Chat 中 URL 自动识别并抓取正文入上下文 | 抓取复用 crawler；附件机制（§6） |
| R2 | 短文字输入 | 已满足 |
| R3 | 长文章输入（Chat 入口：存为书签并引用 / 直接作上下文，需截断策略） | R1 |
| R4 | 语音转文字输入（录音 → 转写 → 回填输入框） | ASR 管道（§5） |
| R5 | 音频文件收藏（上传 → ASSET 书签 → 转录 → 可搜索/摘要/打标） | §5 + 上传白名单 |
| R6 | Agent 工具增强（`create_bookmark` 支持文本/文章；新增音频保存路径） | R5 |

---

## 4. ASR 选型方案（展开）

### 4.1 候选方案总览

| 方案 | 协议 | 价格 | 单请求限制 | 中文质量 | 集成成本 |
|---|---|---|---|---|---|
| A. OpenAI 官方（gpt-transcribe / mini / whisper-1） | OpenAI 兼容 | $0.003~0.006/分钟 | 25MB，mp3/m4a/wav/webm 等 | 一般 | 低 |
| B. 硅基流动 SiliconFlow（SenseVoiceSmall） | **OpenAI 兼容** | **免费** | 50MB、≤1 小时 | **优**（40 万小时中文数据训练） | 低 |
| C. 阿里百炼 Fun-ASR（paraformer / fun-asr 系列） | 私有 WebSocket | 约 0.02 元/分钟（0.00033 元/秒），有免费额度 | 按模型 | 优 | 高 |
| D. 自托管 faster-whisper / whisper.cpp + Speaches | OpenAI 兼容（Speaches） | 免费（需 GPU：large-v3 INT8 约 3GB VRAM，6GB 卡可跑） | 自定 | 一般（Whisper 中文） | 高 |
| E. 浏览器 Web Speech API | 浏览器原生 | 免费 | — | 一般 | 低，但仅 Chrome 系，**Mobile 不可用** |
| F. OpenAI Realtime 流式（gpt-live-transcribe 等） | WebSocket | $0.017/分钟 | — | 好 | 高 |

### 4.2 各方案详评

**A. OpenAI 官方**
- 端点 `POST /v1/audio/transcriptions`，OpenAI SDK 原生支持（`openai.audio.transcriptions.create`）。
- 现价：gpt-transcribe $0.0045/min（官方推荐文件转录）、gpt-4o-mini-transcribe $0.003/min、whisper-1 $0.006/min（legacy，仅它支持词级时间戳）。
- 硬限制：**25MB/请求**（长音频需客户端压缩或切片）；无批内说话人分离（diarize 版同价另算）。
- 适合：已有 OpenAI key、以英文/多语为主的部署。

**B. 硅基流动 SiliconFlow（推荐默认，国内场景）**
- 端点 `POST https://api.siliconflow.cn/v1/audio/transcriptions`，**OpenAI 兼容**（multipart，`file` + `model`，返回 `{text}`）。
- 模型 `FunAudioLLM/SenseVoiceSmall`：**免费**；`TeleAI/TeleSpeechASR` 备选。
- 限制宽松：**单文件 ≤ 50MB、时长 ≤ 1 小时**。
- SenseVoice 为阿里开源模型，中文识别显著优于 Whisper（社区实测中文词错误率大幅低于 Whisper 同级；附带情感/事件检测能力，本需求暂不使用）。
- 国内直连、无需代理。适合：中文为主的个人/小团队部署。

**C. 阿里百炼 Fun-ASR**
- 价格约 0.00033 元/秒（fun-asr-realtime），部分模型有 10 小时免费额度，RPM 高。
- 协议为私有 WebSocket（run-task / 流式分片 / finish-task），**不兼容 OpenAI SDK**，需独立适配层。
- 仅当需要"边说边出字"实时流式时才有不可替代性（见 §5.7）。本期文件转录场景不选。

**D. 自托管（faster-whisper + Speaches / whisper.cpp）**
- faster-whisper（CTranslate2）：large-v3 INT8 约 3GB VRAM，6GB 显卡可跑，速度约 4 倍于官方实现；CPU 也可跑但慢于实时。
- Speaches（原 faster-whisper-server）提供 **OpenAI 兼容** API；whisper.cpp 自带 HTTP server（非 OpenAI 兼容）。
- 零 API 费用、数据不出内网；代价是 GPU 资源与运维。中文质量仍是 Whisper 水准（一般）。
- 适合：已有 GPU 的自建实例、隐私敏感场景。

**E. 浏览器 Web Speech API**
- 免费零后端，但仅 Chrome 系可用、识别质量一般，且 **Expo/RN 环境不可用** → 双端方案分裂。**排除**。

**F. OpenAI Realtime 流式**
- $0.017/min，为"边说边出字"设计。本期按"录完再转"设计，不选；留作未来实时转写升级路径（与 C 二选一）。

### 4.3 推荐选型：以 OpenAI 兼容协议为唯一集成层

**核心结论：`inferFromAudio` 只实现一次，基于 OpenAI SDK 的 `audio.transcriptions.create`；供应商通过现有 `OPENAI_BASE_URL` + 新增 `INFERENCE_SPEECH_MODEL` 配置切换，天然覆盖方案 A/B/D。**

| 部署场景 | BASE_URL | 模型 | 成本 |
|---|---|---|---|
| 国内（默认推荐） | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | 免费 |
| 国际/OpenAI 已有 key | （不设，走官方） | `gpt-4o-mini-transcribe`（性价比）或 `gpt-transcribe` | $0.003~0.0045/min |
| 自建 GPU | Speaches 地址 | `whisper-large-v3` 等 | 免费（硬件自担） |

理由：
1. 与现有 `InferenceClient` 架构完全同构（`buildOpenAIClient` 已支持 baseURL/proxy/timeout，见 [inference.ts](../packages/shared/inference.ts) 的 `OpenAIInferenceConfig`）。
2. 集成按**最小公共子集**设计（`file` + `model` → `{text}`），规避各家 `language`/`response_format` 等差异字段。
3. 未配置语音模型时功能自动隐藏（复用 `InferenceClientFactory.build()` 的降级探测模式），与现有"无 AI 配置则隐藏 AI 功能"行为一致。
4. 方案 C（阿里）若未来需要，再单独加适配器，不影响本期。

**成本测算示例**（个人知识库量级：每天 10 条 1 分钟语音 ≈ 月 5 小时）：
- SiliconFlow：0 元；OpenAI mini：约 $0.9/月；gpt-transcribe：约 $1.35/月。
- 结论：个人部署成本可忽略，真正的风险是**滥用**（见 §4.5 防护）。

### 4.4 `inferFromAudio` 接口设计（草案）

对齐现有 `inferFromText` / `inferFromImage` 模式：

```ts
// packages/shared/inference.ts（新增）
export interface InferenceClient extends EmbeddingClient {
  // ...现有方法
  inferFromAudio(
    file: ReadableStream<Uint8Array> | Buffer, // 或 toFile(...) 包装
    fileName: string,
    opts: { abortSignal?: AbortSignal },
  ): Promise<{ text: string }>;
}

// OpenAIInferenceClient 实现（伪代码）
async inferFromAudio(file, fileName, opts) {
  const transcription = await this.openAI.audio.transcriptions.create({
    file: await toFile(file, fileName),  // openai SDK 的 toFile helper
    model: this.config.speechModel,      // 新增配置项
  });
  return { text: transcription.text };
}
```

配置新增（对齐 `INFERENCE_TEXT_MODEL` / `INFERENCE_IMAGE_MODEL`）：

```
INFERENCE_SPEECH_MODEL=FunAudioLLM/SenseVoiceSmall
# 复用现有：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_PROXY_URL / INFERENCE_TIMEOUT_SEC
```

注意：Ollama 分支（`OllamaInferenceClient`）无转录能力 → 该客户端 `inferFromAudio` 抛 NotImplemented 或直接不支持（文档标注：Ollama 部署无语音功能）。

### 4.5 防护与降级

| 防护点 | 措施 |
|---|---|
| 上传滥用 | 复用 `assets.upload` 30 req/min 限频 + 存储配额；新增**单文件时长上限（建议 30 分钟）与单日转录分钟数上限** |
| 文件校验 | 白名单严格枚举 `audio/mpeg|audio/mp4|audio/webm|audio/wav|audio/x-m4a`（file-type 嗅探 + 后缀双重校验） |
| 转录失败 | 重试 1 次（队列级），失败则书签/附件标记 `failed`，UI 可手动重试，不阻塞其他管道 |
| 供应商故障 | 转录 job 报错信息透传到 UI；音频文件本身已落库，随时可换供应商重转 |
| 无配置 | 语音入口隐藏；已有音频书签仍可播放（transcript 为空） |

### 4.6 未来升级路径：实时流式转写

"边说边出字"需要 WebSocket 流式 ASR：OpenAI Realtime（$0.017/min）或阿里 fun-asr-realtime（约 0.02 元/分钟）。若立项，建议独立评估（新增流式网关 + 前端 VAD），与本期的文件转录管道解耦，复用同一供应商配置。

---

## 5. Chat 附件协议设计（细化）

### 5.1 设计原则

1. **复用 assets 体系**：二进制存储、配额、鉴权全部走现有 `POST /api/assets` + `Asset.fromId().ensureCanView()`，不新建存储。
2. **`chatMessages.content` 保持纯文本**：兼容现有渲染、`generateTitle`、流式聚合逻辑；附件全部进 `metadata` JSON 列（[schema.ts](../packages/db/schema.ts) 已有该列，**无迁移成本**）。
3. **附件正文不存 metadata**：转录文本/抓取正文存为 assetDB 中的 `text/plain` 资产（需在 `SUPPORTED_ASSET_TYPES` 增加 `TEXT_PLAIN`），metadata 只存引用。理由：① 避免消息行膨胀（长转录可达数万字）② 与音频书签共用同一转录管道 ③ 配额天然覆盖。
4. **异步预完成**：抓取/转录在上传后立即由 worker 处理，`sendMessage` 时**只读结果**——规避单消息 120s 超时（[orchestrator.ts](../packages/trpc/lib/agent/orchestrator.ts) `TOTAL_MESSAGE_TIMEOUT_MS`）。
5. **附件必须伴随文字指令**（v1）：`content.min(1)` 不放宽，简化交互；纯附件发送列为开放问题。

### 5.2 数据模型（草案）

`chatMessages.metadata`（JSON 列，zod 草案）：

```ts
const zChatAttachment = z.object({
  assetId: z.string(),                        // 原始附件（音频/PDF/图片）的 assetId
  kind: z.enum(["audio", "pdf", "image", "link", "text"]),
  status: z.enum(["pending", "ready", "failed"]),
  // kind=link 时无本地 asset，直接存 url
  url: z.string().url().optional(),
  // 正文引用（kind=audio/pdf/text/link 的可注入文本；text/plain 资产）
  transcriptAssetId: z.string().optional(),
  durationSec: z.number().optional(),         // audio
  title: z.string().optional(),               // link 的页面标题
  error: z.string().optional(),               // failed 原因
  createdAt: z.string(),                      // ISO
});

const zChatMessageMetadata = z.object({
  attachments: z.array(zChatAttachment).max(4).optional(),
});
```

容量约束：单条消息最多 4 个附件（对齐主流 Chat 产品，控制 token 预算）。

### 5.3 端到端流程

```
[前端] 选择文件 / 录音完成 / 粘贴链接
   │
   ├─ 二进制附件: POST /api/assets (multipart) ──→ { assetId, contentType, size }
   │
   ├─ tRPC chats.prepareAttachment({ assetId?, kind, url? })
   │     ├─ 校验 asset 归属（userId 匹配）
   │     ├─ 入预处理队列：
   │     │    audio → 转录 job（§4 管道）→ transcript 存 text/plain 资产
   │     │    pdf   → 现有 assetPreprocessing 文本提取
   │     │    link  → crawler 抓正文 → text/plain 资产
   │     │    text  → 直接存 text/plain 资产
   │     │    image → 无需预处理（多模态模型时直接引用）
   │     └─ 返回 attachment 占位 { status: "pending" }
   │
   ├─ 前端轮询/订阅 chats.getAttachment({ assetId | url }) → status: ready | failed
   │
[用户点击发送] tRPC chats.sendMessage({ sessionId, content, attachmentRefs: [...] })
   ├─ 校验归属 + status=ready（pending 时拒绝或自动等待，见开放问题 3）
   ├─ user 消息落库：content 原文 + metadata.attachments
   └─ orchestrator.prompt = content + 附件正文注入（§5.4）
```

Mobile 端 `sendMessageSync` 同样扩展 `attachmentRefs` 入参，复用同一组装逻辑。

### 5.4 orchestrator 上下文注入与截断策略

注入格式（拼接进 prompt，置于用户消息之后）：

```
{用户文字消息}

<attachment id="1" kind="audio" duration="155s">
{转录正文}
</attachment>
<attachment id="2" kind="link" url="https://...">
{抓取正文（markdown）}
</attachment>
```

**Token 预算分配**（可配置常量）：

| 项 | 预算 | 超额行为 |
|---|---|---|
| 单附件注入 | ≤ 4k tokens | 截断 + 末尾标注 `（原文过长已截断，完整内容已存为书签/附件）` |
| 全部附件合计 | ≤ 8k tokens | 逐附件降级：先截断，再按顺序仅保留摘要（复用现有 summarize 管道） |
| 附件 + 历史消息 | ≤ 模型上下文 50% | 优先保附件（当前问题相关性最高），历史消息按现有逻辑裁剪 |

实现要点：注入发生在 `streamConversation` 组装 prompt 处（[orchestrator.ts](../packages/trpc/lib/agent/orchestrator.ts)），从 `transcriptAssetId` 读 text/plain 资产；转录已预完成，此处无网络调用，**不增加 120s 超时压力**。

### 5.5 tRPC 接口变更清单

| 接口 | 变更 |
|---|---|
| `chats.sendMessage` / `sendMessageSync` | input 增加 `attachmentRefs: z.array(z.object({ assetId: z.string().optional(), url: z.string().url().optional() })).max(4).optional()`；落库时写入 metadata |
| `chats.prepareAttachment`（新增） | 触发预处理并返回占位状态 |
| `chats.getAttachment`（新增） | 查询附件状态（pending/ready/failed + transcript 引用），供前端轮询 |
| `chats.getSession` | 返回值带上 `metadata.attachments`（前端渲染附件卡片） |
| `chats.generateTitle` | transcript 参与首条消息截断时，用附件标题/前 100 字代替，避免标题生成拿到空串 |

### 5.6 前端 UI 状态机

```
idle → uploading（上传二进制）→ processing（转录/抓取中，禁用发送或允许发送但标记）
     → ready（显示附件卡片：类型图标/时长/文件名）→ sent（随消息气泡展示）
     → failed（显示错误 + [重试] [移除]）
```

- 附件卡片随消息气泡渲染（ChatMessage 组件扩展）；点击音频卡片用 `/api/assets/:id` 播放。
- 语音转文字输入（R4）复用同一管道：录音 → 上传 → 转录 → **回填输入框**（用户可编辑）→ 正常发送；此时转录结果作为纯文本发送，不产生附件引用。
- 发送按钮可用条件：有文字，或存在至少一个 status=ready 的附件（纯附件可发送，决策 D2）。

### 5.7 鉴权、配额与清理

| 项 | 方案 |
|---|---|
| 附件读取 | 前端渲染走现有 `GET /api/assets/:assetId`（`ensureCanView` 校验归属）；转录文本资产同路径 |
| 配额 | 上传即计配额（现有逻辑）；transcript（text/plain）体积小，计入同一配额 |
| 孤儿附件 GC | 上传后 24h 未被任何 chatMessage/bookmark 引用的 `userUploaded` 资产 → 扩展现有 `adminMaintenance/tidyAssets` 定期清理 |
| 会话删除 | 消息级联删除已有；对应附件资产由孤儿 GC 兜底回收 |

### 5.8 与音频书签管道的关系（统一转录层）

`audioTranscriptionWorker`（新）服务两条路径，同一份代码：

```
上传音频 asset ──→ audioTranscriptionWorker ──→ transcript(text/plain 资产)
                         │
     ┌───────────────────┴──────────────────┐
 ASSET 书签路径                      Chat 附件路径
 transcript → 摘要/打标/嵌入            transcriptAssetId → 对话注入
 （书签卡片显示播放器 + 转录）         （消息气泡附件卡片）
```

书签路径需同步改动：`SUPPORTED_BOOKMARK_ASSET_TYPES` 增加 audio 类型（[assetdb.ts](../packages/shared/assetdb.ts)）、`createBookmark` 的 assetType 枚举增加 `"audio"`（[bookmarks.ts](../packages/shared/types/bookmarks.ts) 的 `z.enum(["image","pdf"])`）、前端 `AssetCard` 音频播放器、上传映射处（[UploadDropzone.tsx](../apps/web/components/dashboard/UploadDropzone.tsx) 现为 `pdf? pdf : image` 硬编码）。

---

## 6. 全景改动面与分期

| 阶段 | 内容 | 规模 | 前置 |
|---|---|---|---|
| **P0 快赢** | ① `create_bookmark` 工具支持 `text` 参数（TEXT 书签已存在）② Chat 输入 URL 正则识别 + 系统提示词引导 AI 调用抓取工具 | 小 | 无 |
| **P1 音频管道** | ③ 上传白名单 + ASSET_TYPES + assetType 枚举扩展 ④ `INFERENCE_SPEECH_MODEL` + `inferFromAudio` ⑤ `audioTranscriptionWorker` ⑥ 音频书签（上传入口双端 + 播放器 + 转录展示）⑦ 语音转文字输入按钮（双端） | 中—大 | ④→⑤→⑥⑦ |
| **P2 Chat 附件体系** | ⑧ metadata 协议 + prepareAttachment/getAttachment ⑨ 附件卡片 UI + 状态机 ⑩ orchestrator 注入与截断 ⑪ URL/长文/音频作为上下文 | 中—大 | P1 的 ⑤（音频）；URL/长文部分仅依赖 crawler |

## 7. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| ASR 成本与滥用（无限制上传） | 高 | §4.5：限频 + 配额 + 单文件时长上限 + 日转录分钟数上限 |
| 转录时延 × 120s 消息超时 | 高 | 严格异步预转录，对话只读结果（§5.1 原则 4） |
| OpenAI 兼容端点行为差异（错误码/字段） | 中 | 只用最小公共子集；错误按"供应商错误"统一透传 |
| 与上游 Karakeep 漂移加大 | 中 | worker 设计参照上游模式（audio worker + transcript asset），保持同构 |
| 长转录撑大消息/上下文 | 中 | transcript 存资产不存消息行；注入预算截断（§5.4） |
| 双端实现不一致 | 中 | 转录/抓取全在服务端，前端只做录音与上传 |
| 无 AI 配置 | 低 | 配置探测隐藏入口；音频文件仍可收藏播放 |

## 8. 决策记录（v0.3，原开放问题已全部定案）

| 编号 | 决策项 | 结论 |
|---|---|---|
| D1 | ASR 供应商默认值 | 文档示例默认 SiliconFlow（免费 + 中文优），代码不写死，纯配置切换（`OPENAI_BASE_URL` + `INFERENCE_SPEECH_MODEL`） |
| D2 | 纯附件发送 | **允许**。`content` 可选，与 `attachmentRefs` 至少其一非空；纯语音/纯文件可直接发送 |
| D3 | 附件 pending 时发送 | v1 拒绝发送并提示（UI 等待 ready），不做自动等待 |
| D4 | 音频书签向量嵌入 | **参与**语义搜索，P1 增加转录 embeddings 分支 |
| D5 | 存储配额 | Chat 附件与书签资产共用同一配额 |
| D6 | Mobile 系统分享菜单收音频 | 本期不做，P2 之后评估 |

## 9. 参考资料（评估时点 2026-09）

- OpenAI 转录价格与模型：developers.openai.com/api/docs/pricing（gpt-transcribe $0.0045/min、gpt-4o-mini-transcribe $0.003/min、whisper-1 $0.006/min、25MB 限制）
- SiliconFlow 语音转文本 API：docs.siliconflow.com / api-docs.siliconflow.cn（SenseVoiceSmall 免费、50MB/1h 限制、OpenAI 兼容端点 `/v1/audio/transcriptions`）
- 阿里百炼 Fun-ASR：help.aliyun.com/zh/model-studio（fun-asr-realtime 0.00033 元/秒、WebSocket 协议）
- faster-whisper / Speaches / whisper.cpp 自托管：github.com/SYSTRAN/faster-whisper、speaches（OpenAI 兼容 server）、ggerganov/whisper.cpp（large-v3 INT8 约 3GB VRAM）
