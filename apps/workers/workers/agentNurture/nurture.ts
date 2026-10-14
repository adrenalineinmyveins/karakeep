import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { DB } from "@saiye/db";
import {
  agentMemories,
  agentProfiles,
  bookmarkLinks,
  bookmarks,
  bookmarksInLists,
  tagsOnBookmarks,
} from "@saiye/db/schema";
import type { InferenceClient } from "@saiye/shared/inference";
import logger from "@saiye/shared/logger";
import type {
  AgentNurtureState,
  KnowledgeScope,
} from "@saiye/shared/types/agentProfiles";

/**
 * D2 agent 喂养核心：画像更新（bio/专长标签）+ agentMemories 沉淀。
 * D2-b 增量触发：nurtureState.lastCursor 游标，只处理游标之后变更的书签。
 */

/** memories 容量上限（与 trpc memories router 的 MAX_MEMORIES 保持一致） */
export const MAX_MEMORIES = 100;

/** 单次喂养批次上限（取最近的 N 条增量书签喂给 LLM） */
export const NURTURE_BATCH = 50;
/** 触发阈值：增量 ≥ N 条才值得跑一次 LLM（D2-b 成本控制） */
export const NURTURE_MIN_CHANGES = 20;
/** 兜底周期：超过 7 天未喂养且有新变化也触发（低频用户也能定期刷新画像） */
export const NURTURE_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/** LLM 结构化输出：第三人称简介 + 专长标签 + 长期记忆沉淀 */
export const zNurtureOutputSchema = z.object({
  bio: z.string().max(500),
  expertiseTags: z.array(z.string().min(1).max(30)).min(3).max(8),
  memories: z.array(z.string().min(1).max(2000)).max(3),
});
export type NurtureOutput = z.infer<typeof zNurtureOutputSchema>;

/** scope 是否实际生效（与 trpc knowledgeRetrieval.isScopeActive 同规则） */
function isScopeActive(scope: KnowledgeScope | null | undefined): boolean {
  if (!scope) {
    return false;
  }
  return scope.tagIds.length > 0 || scope.listIds.length > 0;
}

/**
 * 书签查询的 scope 条件：书签挂任一绑定标签或位于任一绑定清单
 * （与 trpc knowledgeRetrieval.scopedBookmarkFilter 同模式）。
 * raw SQL 中的驼峰表名/列名必须加双引号，否则 PG 会折叠为小写。
 */
function scopedBookmarkFilter(scope: KnowledgeScope): SQL | undefined {
  const parts: SQL[] = [];
  if (scope.tagIds.length > 0) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM "tagsOnBookmarks" WHERE "tagsOnBookmarks"."bookmarkId" = ${bookmarks.id} AND ${inArray(tagsOnBookmarks.tagId, scope.tagIds)})`,
    );
  }
  if (scope.listIds.length > 0) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM "bookmarksInLists" WHERE "bookmarksInLists"."bookmarkId" = ${bookmarks.id} AND ${inArray(bookmarksInLists.listId, scope.listIds)})`,
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return or(...parts);
}

/** 增量书签行（喂给 LLM 的最小字段） */
interface IncrementalBookmark {
  id: string;
  title: string | null;
  summary: string | null;
  note: string | null;
  url: string | null;
  modifiedAt: Date | null;
}

/**
 * 收集增量书签（D2-b）：modifiedAt > 游标，按 modifiedAt 倒序取最近 N 条
 * （首次无游标 = 全库最近 N 条）。游标单调向前，旧书签不会重复处理。
 */
async function collectIncremental(
  db: DB,
  userId: string,
  scope: KnowledgeScope | null,
  cursorIso: string | null,
  limit: number,
): Promise<IncrementalBookmark[]> {
  const cursor = cursorIso ? new Date(cursorIso) : null;
  const scopeSql = isScopeActive(scope)
    ? scopedBookmarkFilter(scope!)
    : undefined;
  return db
    .select({
      id: bookmarks.id,
      title: bookmarkLinks.title,
      summary: bookmarks.summary,
      note: bookmarks.note,
      url: bookmarkLinks.url,
      modifiedAt: bookmarks.modifiedAt,
    })
    .from(bookmarks)
    .leftJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .where(
      and(
        eq(bookmarks.userId, userId),
        // modifiedAt 为 null 的异常/极旧行不参与喂养（游标比较对 null 恒假）
        isNotNull(bookmarks.modifiedAt),
        ...(cursor ? [gt(bookmarks.modifiedAt, cursor)] : []),
        ...(scopeSql ? [scopeSql] : []),
      ),
    )
    .orderBy(desc(bookmarks.modifiedAt))
    .limit(limit);
}

/** 增量条数（cron 触发评估用，不取行） */
async function countIncremental(
  db: DB,
  userId: string,
  scope: KnowledgeScope | null,
  cursorIso: string | null,
): Promise<number> {
  const cursor = cursorIso ? new Date(cursorIso) : null;
  const scopeSql = isScopeActive(scope)
    ? scopedBookmarkFilter(scope!)
    : undefined;
  const [row] = await db
    .select({ n: count() })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        isNotNull(bookmarks.modifiedAt),
        ...(cursor ? [gt(bookmarks.modifiedAt, cursor)] : []),
        ...(scopeSql ? [scopeSql] : []),
      ),
    );
  return row?.n ?? 0;
}

/** cron 触发评估：增量达阈值，或超兜底周期且有变化（仅 hosted + nurtureAuto） */
export async function shouldNurture(
  db: DB,
  profile: {
    id: string;
    userId: string;
    type: string;
    nurtureAuto: boolean;
    knowledgeScope: KnowledgeScope | null;
    nurtureState: AgentNurtureState | null;
  },
): Promise<boolean> {
  if (profile.type !== "hosted" || !profile.nurtureAuto) {
    return false;
  }
  const n = await countIncremental(
    db,
    profile.userId,
    profile.knowledgeScope,
    profile.nurtureState?.lastCursor ?? null,
  );
  if (n === 0) {
    return false;
  }
  if (n >= NURTURE_MIN_CHANGES) {
    return true;
  }
  const lastRunAt = profile.nurtureState?.lastRunAt ?? 0;
  return Date.now() - lastRunAt >= NURTURE_MAX_IDLE_MS;
}

/** 书签行 → prompt 摘要行（title | summary/note 截断 | url 域名） */
function formatBookmarkLine(b: IncrementalBookmark): string {
  const digest =
    (b.summary?.trim() || b.note?.trim() || "").slice(0, 200) || "(无摘要)";
  const host = b.url ? ` | ${new URL(b.url).hostname}` : "";
  return `- ${b.title ?? "(无标题)"}：${digest}${host}`;
}

function buildNurturePrompt(
  agentName: string,
  existingTags: string[] | null,
  batch: IncrementalBookmark[],
): string {
  const tagHint = existingTags?.length
    ? `\n当前已有专长标签（可在其基础上演化）：${existingTags.join("、")}`
    : "";
  return [
    `你正在为用户的个人知识库 Agent「${agentName}」生成喂养画像。`,
    `以下是用户最近收藏/变更的书签（按时间倒序）：`,
    ...batch.map(formatBookmarkLine),
    tagHint,
    "",
    "请基于以上书签输出 JSON：",
    "- bio：该 Agent 的第三人称能力简介（它精通什么、能帮人做什么，120 字内）",
    "- expertiseTags：3-8 个专长标签（中文，每个 ≤ 8 字）",
    "- memories：0-3 条值得长期记住的领域事实/用户兴趣画像（第三人称，每条 ≤ 200 字；无明确事实则空数组）",
  ].join("\n");
}

/**
 * memories 沉淀（与 trpc memories router 同规则：精确去重 + 容量满跳过）。
 * 去重命中只刷新 modifiedAt；容量满静默跳过（喂养是后台增强，不打断）。
 */
async function appendMemories(db: DB, userId: string, contents: string[]) {
  for (const content of contents) {
    const [existing] = await db
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.userId, userId),
          eq(agentMemories.content, content),
        ),
      )
      .limit(1);
    if (existing) {
      await db
        .update(agentMemories)
        .set({ modifiedAt: new Date() })
        .where(eq(agentMemories.id, existing.id));
      continue;
    }
    const [{ total }] = await db
      .select({ total: count() })
      .from(agentMemories)
      .where(eq(agentMemories.userId, userId));
    if (total >= MAX_MEMORIES) {
      logger.info(
        `[agentNurture] memories 已满（${total}/${MAX_MEMORIES}），跳过沉淀新记忆`,
      );
      continue;
    }
    await db.insert(agentMemories).values({ userId, content });
  }
}

/**
 * 喂养一个 hosted 档案：收集增量书签 → LLM 生成画像 → 落库推进游标。
 * - bio/专长标签仅在 nurtureAuto 时覆盖（用户手工修正后自动刷新停摆）
 * - memories 沉淀总是执行（个人记忆资产，注入仅用于本人会话）
 * - 无增量时只刷新 lastRunAt（占位心跳），不调用 LLM
 */
export async function nurtureProfile(
  db: DB,
  inferenceClient: InferenceClient,
  profileId: string,
): Promise<"done" | "skipped" | "no_changes"> {
  const [profile] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.id, profileId))
    .limit(1);
  if (!profile) {
    return "skipped";
  }
  // 仅 hosted 型需要平台侧喂养（外接型大脑在外部）
  if (profile.type !== "hosted") {
    return "skipped";
  }

  const prev = profile.nurtureState;
  const batch = await collectIncremental(
    db,
    profile.userId,
    profile.knowledgeScope,
    prev?.lastCursor ?? null,
    NURTURE_BATCH,
  );

  // SQL 层已过滤 modifiedAt IS NOT NULL；类型上仍可能为 null，取首个非空值兜底
  const newest = batch.find((b) => b.modifiedAt)?.modifiedAt ?? null;
  const nextState: AgentNurtureState = {
    // desc 首行 = 本批最新 modifiedAt；游标单调向前
    lastCursor: newest ? newest.toISOString() : (prev?.lastCursor ?? null),
    lastRunAt: Date.now(),
    runsCount: (prev?.runsCount ?? 0) + 1,
  };

  if (batch.length === 0) {
    await db
      .update(agentProfiles)
      .set({ nurtureState: nextState })
      .where(eq(agentProfiles.id, profileId));
    return "no_changes";
  }

  const prompt = buildNurturePrompt(profile.name, profile.expertiseTags, batch);
  const result = await inferenceClient.inferFromText(prompt, {
    schema: zNurtureOutputSchema,
  });
  const output = zNurtureOutputSchema.parse(JSON.parse(result.response));

  await appendMemories(db, profile.userId, output.memories);

  await db
    .update(agentProfiles)
    .set({
      ...(profile.nurtureAuto
        ? { bio: output.bio, expertiseTags: output.expertiseTags }
        : {}),
      nurtureState: nextState,
      modifiedAt: new Date(),
    })
    .where(eq(agentProfiles.id, profileId));

  logger.info(
    `[agentNurture] profile ${profileId} nurtured: ${batch.length} bookmarks, tags=${output.expertiseTags.join("/")}, memories+${output.memories.length} (${result.totalTokens} tokens)`,
  );
  return "done";
}
