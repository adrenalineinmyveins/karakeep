/**
 * 知识检索（原三源 RAG）：收藏（link）+ 笔记（text）+ 对话记忆（chatMessages）
 * + 长期记忆（agentMemories，B1 起第四源，全量注入）。
 *
 * 设计约束（见阶段 A 任务拆解文档）：
 * - 不依赖 Meilisearch（实测未运行）与向量库，纯 SQL LIKE 检索
 * - CJK 2-gram 切词 + 停用词 + 最多 16 个 token，控制 LIKE 条件数
 * - 候选池 40 条 → 覆盖数重排 → 书签 top 5 / 对话 top 3
 * - 每片段 500 字符截断；任何失败静默降级（返回 []，不打断对话）
 */

import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import { db } from "@saiye/db";
import {
  agentMemories,
  bookmarkLinks,
  bookmarkTexts,
  bookmarks,
  bookmarksInLists,
  chatMessages,
  chatSessions,
  tagsOnBookmarks,
} from "@saiye/db/schema";
import logger from "@saiye/shared/logger";
import serverConfig from "@saiye/shared/config";

// ── 常量 ──────────────────────────────────────────────

/**
 * 最多取多少个检索 token（控制 LIKE OR 条件数，SQLite 无索引全表扫描）。
 * 中文口语查询句首常为虚词（"我之前…"），gram 按出现顺序截断，
 * 上限需足够覆盖到句中实词，否则有效 token 被虚词挤出。
 */
const MAX_TOKENS = 16;
/** 书签候选池大小（重排前） */
const BOOKMARK_CANDIDATE_LIMIT = 40;
/** 重排后保留的书签片段数（A3: env KNOWLEDGE_BOOKMARK_TOP_K 可调，默认 5） */
const BOOKMARK_TOP_K = serverConfig.chat.knowledgeContext.bookmarkTopK;
/** 重排后保留的对话片段数（A3: env KNOWLEDGE_CHAT_TOP_K 可调，默认 3） */
const CHAT_TOP_K = serverConfig.chat.knowledgeContext.chatTopK;
/** 每片段内容截断长度 */
const SNIPPET_MAX_CHARS = 500;
/** 图谱扩展邻居书签数上限（A5） */
const GRAPH_EXPAND_LIMIT = 4;
/** 第二跳关联查询的单侧行数上限（防大清单拖回全库） */
const GRAPH_HOP_ROW_LIMIT = 200;

/** 中英文常见停用词（命中即不作为检索 token） */
const STOP_WORDS = new Set([
  // 中文
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "什么",
  "怎么",
  "可以",
  "没有",
  "一个",
  "一些",
  "还是",
  "就是",
  "但是",
  "因为",
  "所以",
  "如果",
  "的话",
  "一下",
  "需要",
  "帮我",
  "看看",
  "请问",
  // 英文
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "with",
  "at",
  "by",
  "from",
  "this",
  "that",
  "it",
  "as",
  "me",
  "my",
  "you",
  "your",
]);

// ── 类型 ──────────────────────────────────────────────

/** 检索出的知识片段（数据源无关，注入方只认这个结构） */
export interface KnowledgeChunk {
  source: "bookmark" | "chat" | "memory";
  /** 书签标题或对话会话标题 */
  title?: string | null;
  /** link 型书签的原始 URL */
  url?: string | null;
  /** 对话消息的角色（chat 片段） */
  role?: "user" | "assistant" | "toolResult";
  content: string;
  /** A5 图谱扩展片段：经共享标签/清单关联（非直接命中） */
  viaGraph?: boolean;
}

export interface KnowledgeRetrievalParams {
  userId: string;
  /** 当前用户消息（检索 query） */
  query: string;
  /** 排除的会话（当前对话自身不作为记忆源） */
  excludeChatId?: string;
}

// ── 切词 ──────────────────────────────────────────────

/**
 * 查询切词：
 * - ASCII 字母数字串（≥2 字符）整体作为一个 token
 * - 连续 CJK 段切成 2-gram（跨标点不组合；单字段丢弃，避免 LIKE 过泛）
 */
export function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();

  for (const word of query.match(/[a-zA-Z0-9]{2,}/g) ?? []) {
    const lower = word.toLowerCase();
    if (!STOP_WORDS.has(lower)) {
      tokens.add(lower);
    }
  }

  for (const seg of query.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < seg.length; i++) {
      const gram = seg.slice(i, i + 2);
      if (!STOP_WORDS.has(gram)) {
        tokens.add(gram);
      }
    }
  }

  return [...tokens].slice(0, MAX_TOKENS);
}

/** LIKE 通配符转义（配合 ESCAPE '\'） */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 列 LIKE 条件 */
function like(col: unknown, token: string) {
  return sql`${col} LIKE ${`%${escapeLike(token)}%`} ESCAPE '\\'`;
}

/** 覆盖数打分：token 在文本中命中的个数 */
function coverageScore(text: string, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    if (text.toLowerCase().includes(token)) {
      score++;
    }
  }
  return score;
}

function truncate(text: string): string {
  return text.length > SNIPPET_MAX_CHARS
    ? `${text.slice(0, SNIPPET_MAX_CHARS)}…`
    : text;
}

/**
 * HTML 转纯文本（用于 link 书签 htmlContent 命中后的片段生成）。
 * 去掉 script/style 与标签、解码常见实体、压缩空白。
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ── 书签检索（收藏 + 笔记） ──────────────────────────

async function searchBookmarks(
  userId: string,
  tokens: string[],
): Promise<{ chunks: KnowledgeChunk[]; seedIds: string[] }> {
  // A2: htmlContent（link 书签抓取的网页正文）纳入 LIKE 匹配——
  // 正文是信息量最大的字段，summary 缺失时它是唯一可命中源。
  // 注意：对大正文列做 LIKE 是全表扫描，靠候选池 limit 控制读取行数。
  // 注意：标题取 bookmarkLinks.title——bookmarks.title 列恒为 NULL（karakeep
  // 的标题实际存在子表），text 书签标题即正文本身。
  const conditions = tokens.flatMap((token) => [
    like(bookmarkLinks.title, token),
    like(bookmarks.summary, token),
    like(bookmarks.note, token),
    like(bookmarkLinks.url, token),
    like(bookmarkLinks.description, token),
    like(bookmarkTexts.text, token),
    like(bookmarkLinks.htmlContent, token),
  ]);

  const rows = await db
    .select({
      id: bookmarks.id,
      title: bookmarkLinks.title,
      summary: bookmarks.summary,
      note: bookmarks.note,
      url: bookmarkLinks.url,
      linkDescription: bookmarkLinks.description,
      textContent: bookmarkTexts.text,
      htmlContent: bookmarkLinks.htmlContent,
    })
    .from(bookmarks)
    .leftJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .leftJoin(bookmarkTexts, eq(bookmarkTexts.id, bookmarks.id))
    .where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.archived, false),
        or(...conditions),
      ),
    )
    .limit(BOOKMARK_CANDIDATE_LIMIT);

  // 覆盖数重排（候选池已按无关顺序取回，重排保证最相关的进 top K）
  const ranked = rows
    .map((row) => {
      // 正文纯文本（link 书签）：截断后参与打分与片段生成，避免超大 HTML 全量处理
      const articleText = row.htmlContent
        ? stripHtml(row.htmlContent).slice(0, 10_000)
        : "";
      // 内容优先级：摘要 > 笔记 > 正文（text 书签）> 链接描述 > 网页正文（link 书签）
      const content =
        row.summary?.trim() ||
        row.note?.trim() ||
        row.textContent?.trim() ||
        row.linkDescription?.trim() ||
        articleText ||
        "";
      if (!content && !row.title) {
        return null;
      }
      const hay = [
        row.title,
        row.summary,
        row.note,
        row.url,
        row.linkDescription,
        row.textContent,
        articleText,
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return {
        id: row.id,
        source: "bookmark" as const,
        title: row.title,
        url: row.url,
        content: truncate(content || row.title!),
        _score: coverageScore(hay, tokens),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => b._score - a._score)
    .slice(0, BOOKMARK_TOP_K);

  return {
    chunks: ranked.map(({ id: _id, _score, ...chunk }) => chunk),
    seedIds: ranked.map((r) => r.id),
  };
}

// ── 对话记忆检索 ──────────────────────────────────────

async function searchChatMessages(
  userId: string,
  tokens: string[],
  excludeChatId?: string,
): Promise<KnowledgeChunk[]> {
  const conditions = tokens.map((token) => like(chatMessages.content, token));

  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      chatTitle: chatSessions.title,
      modifiedAt: chatSessions.modifiedAt,
    })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatSessions.id, chatMessages.chatId))
    .where(
      and(
        eq(chatSessions.userId, userId),
        excludeChatId ? ne(chatMessages.chatId, excludeChatId) : undefined,
        or(...conditions),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(20);

  return rows
    .map((row) => ({
      source: "chat" as const,
      title: row.chatTitle,
      role: row.role,
      content: truncate(row.content),
      _score: coverageScore(row.content.toLowerCase(), tokens),
    }))
    .filter((c) => c._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, CHAT_TOP_K)
    .map(({ _score, ...chunk }) => chunk);
}

// ── 长期记忆（B3：高价值低数量，全量注入 + 上限） ──────

/** 注入的记忆条数上限（超出取最近） */
const MEMORY_LIMIT = 20;

async function loadMemories(userId: string): Promise<KnowledgeChunk[]> {
  const rows = await db
    .select({ content: agentMemories.content })
    .from(agentMemories)
    .where(eq(agentMemories.userId, userId))
    .orderBy(desc(agentMemories.createdAt))
    .limit(MEMORY_LIMIT);
  return rows.map((r) => ({
    source: "memory" as const,
    content: truncate(r.content),
  }));
}

// ── 图谱扩展（A5：命中书签 → 共享标签/清单 → 邻居书签） ──

/**
 * 2 跳图谱扩展：直接命中的书签（seeds）→ 其标签/清单 → 同标签或
 * 同清单的其他书签。共享信号计数排序（标签权重 2、清单权重 1，
 * 大清单的弱关联天然沉底），取 top N 作为补充上下文。
 * 移植自 llm_wiki 的"来源重叠/类型亲和"图谱信号，简化为计数版。
 */
async function expandByGraph(
  userId: string,
  seedIds: string[],
): Promise<KnowledgeChunk[]> {
  if (seedIds.length === 0) {
    return [];
  }

  // 第一跳：seeds 的标签 id 与清单 id
  const [tagRows, listRows] = await Promise.all([
    db
      .select({ tagId: tagsOnBookmarks.tagId })
      .from(tagsOnBookmarks)
      .where(inArray(tagsOnBookmarks.bookmarkId, seedIds)),
    db
      .select({ listId: bookmarksInLists.listId })
      .from(bookmarksInLists)
      .where(inArray(bookmarksInLists.bookmarkId, seedIds)),
  ]);

  const tagIds = [...new Set(tagRows.map((r) => r.tagId))];
  const listIds = [...new Set(listRows.map((r) => r.listId))];
  if (tagIds.length === 0 && listIds.length === 0) {
    return [];
  }

  // 第二跳：同标签/同清单的书签 id（排除 seeds 自身）
  const [siblingTagRows, siblingListRows] = await Promise.all([
    tagIds.length > 0
      ? db
          .select({ bookmarkId: tagsOnBookmarks.bookmarkId })
          .from(tagsOnBookmarks)
          .where(inArray(tagsOnBookmarks.tagId, tagIds))
          .limit(GRAPH_HOP_ROW_LIMIT)
      : Promise.resolve([] as { bookmarkId: string }[]),
    listIds.length > 0
      ? db
          .select({ bookmarkId: bookmarksInLists.bookmarkId })
          .from(bookmarksInLists)
          .where(inArray(bookmarksInLists.listId, listIds))
          .limit(GRAPH_HOP_ROW_LIMIT)
      : Promise.resolve([] as { bookmarkId: string }[]),
  ]);

  const seedSet = new Set(seedIds);
  const counts = new Map<string, number>();
  for (const r of siblingTagRows) {
    if (!seedSet.has(r.bookmarkId)) {
      counts.set(r.bookmarkId, (counts.get(r.bookmarkId) ?? 0) + 2);
    }
  }
  for (const r of siblingListRows) {
    if (!seedSet.has(r.bookmarkId)) {
      counts.set(r.bookmarkId, (counts.get(r.bookmarkId) ?? 0) + 1);
    }
  }

  const neighborIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_EXPAND_LIMIT)
    .map(([id]) => id);
  if (neighborIds.length === 0) {
    return [];
  }

  // 邻居书签内容（字段与 searchBookmarks 一致，同样只取未归档）
  const rows = await db
    .select({
      id: bookmarks.id,
      title: bookmarkLinks.title,
      summary: bookmarks.summary,
      note: bookmarks.note,
      url: bookmarkLinks.url,
      linkDescription: bookmarkLinks.description,
      textContent: bookmarkTexts.text,
      htmlContent: bookmarkLinks.htmlContent,
    })
    .from(bookmarks)
    .leftJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .leftJoin(bookmarkTexts, eq(bookmarkTexts.id, bookmarks.id))
    .where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.archived, false),
        inArray(bookmarks.id, neighborIds),
      ),
    );

  // 保持计数排序顺序
  const byId = new Map(rows.map((row) => [row.id, row]));
  return neighborIds
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => !!row)
    .map((row) => {
      const articleText = row.htmlContent
        ? stripHtml(row.htmlContent).slice(0, 10_000)
        : "";
      const content =
        row.summary?.trim() ||
        row.note?.trim() ||
        row.textContent?.trim() ||
        row.linkDescription?.trim() ||
        articleText ||
        "";
      return {
        source: "bookmark" as const,
        title: row.title,
        url: row.url,
        content: truncate(content || row.title || "(无标题)"),
        viaGraph: true,
      };
    });
}

// ── 注入预算（A5：总字符上限，超预算的低优先级片段丢弃） ──

/** 注入优先级：记忆 > 直接命中书签 > 对话记忆；图谱扩展整体垫底 */
const SOURCE_PRIORITY: Record<KnowledgeChunk["source"], number> = {
  memory: 0,
  bookmark: 1,
  chat: 2,
};

/** 每片段注入时的标注开销估算（标题行 + 分隔，与 buildKnowledgeContextBlock 对应） */
const CHUNK_OVERHEAD_CHARS = 100;

/**
 * 按预算裁剪片段。稳定排序（组内保持检索排序），逐片段累加字符，
 * 放不下的丢弃（continue 而非 break：尾部预算仍可容纳更小的片段）。
 */
export function applyKnowledgeBudget(
  chunks: KnowledgeChunk[],
  maxChars: number,
): KnowledgeChunk[] {
  const sorted = [...chunks].sort(
    (a, b) =>
      (a.viaGraph ? 1 : 0) - (b.viaGraph ? 1 : 0) ||
      SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source],
  );
  const result: KnowledgeChunk[] = [];
  let used = 0;
  for (const c of sorted) {
    const size =
      c.content.length + (c.title?.length ?? 0) + CHUNK_OVERHEAD_CHARS;
    if (used + size > maxChars) {
      continue;
    }
    result.push(c);
    used += size;
  }
  return result;
}

// ── 对外入口 ──────────────────────────────────────────

/**
 * 三源检索入口。失败静默降级（返回 []）：知识注入是增强而非依赖，
 * 检索故障不应打断用户对话。
 */
export async function retrieveKnowledgeContext(
  params: KnowledgeRetrievalParams,
): Promise<KnowledgeChunk[]> {
  const tokens = tokenizeQuery(params.query);
  if (tokens.length === 0) {
    return [];
  }

  try {
    const [bookmarkResult, chatResult, memoryResult] = await Promise.all([
      searchBookmarks(params.userId, tokens),
      searchChatMessages(params.userId, tokens, params.excludeChatId),
      loadMemories(params.userId),
    ]);
    // A5 图谱扩展：以直接命中书签为种子做 2 跳关联（失败静默跳过）
    const graphResult = await expandByGraph(
      params.userId,
      bookmarkResult.seedIds,
    ).catch(() => [] as KnowledgeChunk[]);

    const all = [
      ...memoryResult,
      ...bookmarkResult.chunks,
      ...chatResult,
      ...graphResult,
    ];
    // A5 总预算裁剪：记忆 > 直接命中 > 对话记忆 > 图谱扩展
    return applyKnowledgeBudget(
      all,
      serverConfig.chat.knowledgeContext.maxChars,
    );
  } catch (e) {
    logger.warn(
      `[knowledgeRetrieval] 检索失败，静默降级为无知识注入: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}
