import { createHash } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@saiye/db";
import {
  bookmarkLists,
  bookmarkTags,
  bookmarks,
  bookmarksInLists,
  conceptPageSources,
  conceptPages,
  tagsOnBookmarks,
} from "@saiye/db/schema";
import { triggerConceptMirrorExport } from "@saiye/shared-server";
import logger from "@saiye/shared/logger";
import { InferenceClient } from "@saiye/shared/inference";

import { htmlToMarkdown } from "../mirrorExport";

// How many bookmarks feed a single compile. When the anchor holds more, the
// most recently modified ones win (keeps prompt sizes bounded).
const MAX_SOURCES_PER_COMPILE = 30;
// Per-source content excerpt length (characters) fed to the LLM.
const SOURCE_EXCERPT_CHARS = 1500;

export interface ConceptSource {
  bookmarkId: string;
  title: string | null;
  url: string | null;
  summary: string | null;
  content: string | null;
  modifiedAt: Date | null;
}

// Un-archived bookmarks currently attached to the anchor (tag or list).
export async function collectSourceSet(
  userId: string,
  anchorType: "tag" | "list",
  anchorId: string,
): Promise<ConceptSource[]> {
  let ids: { id: string }[];
  if (anchorType === "tag") {
    ids = await db
      .select({ id: tagsOnBookmarks.bookmarkId })
      .from(tagsOnBookmarks)
      .innerJoin(bookmarks, eq(bookmarks.id, tagsOnBookmarks.bookmarkId))
      .where(
        and(
          eq(tagsOnBookmarks.tagId, anchorId),
          eq(bookmarks.userId, userId),
          eq(bookmarks.archived, false),
        ),
      );
  } else {
    ids = await db
      .select({ id: bookmarksInLists.bookmarkId })
      .from(bookmarksInLists)
      .innerJoin(bookmarks, eq(bookmarks.id, bookmarksInLists.bookmarkId))
      .where(
        and(
          eq(bookmarksInLists.listId, anchorId),
          eq(bookmarks.userId, userId),
          eq(bookmarks.archived, false),
        ),
      );
  }
  if (ids.length === 0) {
    return [];
  }

  const rows = await db.query.bookmarks.findMany({
    where: and(
      inArray(
        bookmarks.id,
        ids.map((r) => r.id),
      ),
      eq(bookmarks.archived, false),
    ),
    columns: {
      id: true,
      title: true,
      summary: true,
      modifiedAt: true,
    },
    with: {
      link: { columns: { url: true, htmlContent: true } },
      text: { columns: { text: true, sourceUrl: true } },
    },
    orderBy: [desc(bookmarks.modifiedAt)],
    limit: MAX_SOURCES_PER_COMPILE,
  });

  return rows.map((b) => ({
    bookmarkId: b.id,
    title: b.title,
    url: b.link?.url ?? b.text?.sourceUrl ?? null,
    summary: b.summary,
    content: b.link?.htmlContent
      ? htmlToMarkdown(b.link.htmlContent)
      : (b.text?.text ?? null),
    modifiedAt: b.modifiedAt,
  }));
}

// Fingerprint of a source set: ids + modification times. A mismatch vs the
// stored hash means the page is stale.
export function computeSourceHash(sources: ConceptSource[]): string {
  const payload = sources
    .map((s) => `${s.bookmarkId}@${s.modifiedAt?.toISOString() ?? ""}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function excerpt(text: string | null, maxChars: number): string {
  if (!text) {
    return "";
  }
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxChars
    ? cleaned
    : `${cleaned.slice(0, maxChars)}…`;
}

export function buildCompilePrompt(
  anchorName: string,
  anchorType: "tag" | "list",
  sources: ConceptSource[],
): string {
  const materials = sources
    .map((s, i) => {
      const parts = [`[${i + 1}] 标题: ${s.title ?? "(无标题)"}`];
      if (s.url) {
        parts.push(`    URL: ${s.url}`);
      }
      if (s.summary) {
        parts.push(`    摘要: ${excerpt(s.summary, 300)}`);
      }
      parts.push(`    正文节选: ${excerpt(s.content, SOURCE_EXCERPT_CHARS)}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const anchorKind = anchorType === "tag" ? "标签" : "清单";
  return `你是一名知识编辑。用户按${anchorKind}「${anchorName}」收藏了以下 ${sources.length} 条材料，请把它们编译成一页结构化的知识综述（Markdown 正文）。

要求：
- 用二级标题（##）分节组织，例如：核心概念、主要观点、观点分歧、演进脉络、实践要点等——按材料的实际内容取舍，不要生搬硬套固定章节
- 只使用材料中出现的信息，禁止编造；材料未覆盖的方面不要提及
- 每个关键论断后用 [n] 标注来源编号，n 对应材料列表编号
- 材料之间观点冲突时，并列陈述各方观点并各自标注来源，不要自行裁决
- 输出语言与材料的主要语言一致
- 直接从第一个二级标题开始，不要输出引言、结尾总结或客套话

材料列表：

${materials}`;
}

export async function resolveAnchorName(
  userId: string,
  anchorType: "tag" | "list",
  anchorId: string,
): Promise<string | null> {
  if (anchorType === "tag") {
    const tag = await db.query.bookmarkTags.findFirst({
      where: and(
        eq(bookmarkTags.id, anchorId),
        eq(bookmarkTags.userId, userId),
      ),
      columns: { name: true },
    });
    return tag?.name ?? null;
  }
  const list = await db.query.bookmarkLists.findFirst({
    where: and(
      eq(bookmarkLists.id, anchorId),
      eq(bookmarkLists.userId, userId),
    ),
    columns: { name: true },
  });
  return list?.name ?? null;
}

// Marks a page as failed while keeping the previous content readable.
export async function markConceptFailure(
  conceptId: string,
  error: string,
): Promise<void> {
  await db
    .update(conceptPages)
    .set({ status: "failure", lastError: error })
    .where(eq(conceptPages.id, conceptId));
}

// Compiles one concept page: collects the current source set, asks the LLM for
// a digest, persists the result + source snapshot, and mirrors it to disk.
// Status transitions: (pending|stale) -> generating -> ready on success.
export async function compileConceptPage(
  conceptId: string,
  inferenceClient: InferenceClient,
  abortSignal?: AbortSignal,
): Promise<"compiled" | "missing" | "skipped"> {
  const page = await db.query.conceptPages.findFirst({
    where: eq(conceptPages.id, conceptId),
  });
  if (!page) {
    return "missing";
  }

  await db
    .update(conceptPages)
    .set({ status: "generating" })
    .where(eq(conceptPages.id, conceptId));

  const anchorName = await resolveAnchorName(
    page.userId,
    page.anchorType,
    page.anchorId,
  );
  if (!anchorName) {
    // Anchor (tag/list) was deleted; leave the row for the reconciliation
    // cron to clean up.
    await markConceptFailure(conceptId, "anchor_deleted");
    return "skipped";
  }

  const sources = await collectSourceSet(
    page.userId,
    page.anchorType,
    page.anchorId,
  );
  const hash = computeSourceHash(sources);

  let content = "";
  if (sources.length > 0) {
    const prompt = buildCompilePrompt(anchorName, page.anchorType, sources);
    const result = await inferenceClient.inferFromText(prompt, {
      schema: null,
      abortSignal,
    });
    if (!result.response?.trim()) {
      throw new Error("Empty response from inference client");
    }
    content = result.response.trim();
    logger.info(
      `[concepts] Compiled page ${conceptId} (${page.slug}) from ${sources.length} sources using ${result.totalTokens} tokens`,
    );
  } else {
    logger.info(
      `[concepts] Page ${conceptId} (${page.slug}) has no sources, storing empty content`,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(conceptPages)
      .set({
        title: anchorName,
        content,
        status: "ready",
        lastError: null,
        sourceCount: sources.length,
        sourceContentHash: hash,
        compileVersion: page.compileVersion + 1,
        lastCompiledAt: new Date(),
      })
      .where(eq(conceptPages.id, conceptId));

    await tx
      .delete(conceptPageSources)
      .where(eq(conceptPageSources.pageId, conceptId));
    if (sources.length > 0) {
      await tx.insert(conceptPageSources).values(
        sources.map((s) => ({
          pageId: conceptId,
          bookmarkId: s.bookmarkId,
        })),
      );
    }
  });

  await triggerConceptMirrorExport(conceptId);
  return "compiled";
}
