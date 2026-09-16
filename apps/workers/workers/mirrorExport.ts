import { promises as fsp } from "node:fs";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";
import TurndownService from "turndown";

import { db } from "@saiye/db";
import {
  bookmarkLists,
  bookmarkTags,
  bookmarks,
  conceptPageSources,
  conceptPages,
  highlights,
} from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";
import logger from "@saiye/shared/logger";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";

// Keep the conversion consistent with the web reader (trpc models/bookmarks.ts)
const turndownService = new TurndownService({
  bulletListMarker: "-",
  headingStyle: "atx",
});

export function htmlToMarkdown(html: string): string {
  return turndownService.turndown(html);
}

export function mirrorFilePath(
  rootDir: string,
  userId: string,
  bookmarkId: string,
): string {
  return path.join(rootDir, userId, `${bookmarkId}.md`);
}

export interface MirrorHighlight {
  text: string | null;
  note: string | null;
}

export interface MirrorBookmarkData {
  id: string;
  userId: string;
  type: "link" | "text" | "asset";
  title: string | null;
  url: string | null;
  summary: string | null;
  note: string | null;
  archived: boolean;
  favourited: boolean;
  createdAt: Date | null;
  modifiedAt: Date | null;
  tags: string[];
  // Full list paths, e.g. ["Reading/Tech"]
  lists: string[];
  // Markdown body; null when there is no textual content (e.g. assets)
  content: string | null;
  highlights: MirrorHighlight[];
}

// YAML frontmatter where every value is serialized with JSON.stringify:
// JSON string/array escapes are valid YAML, and Obsidian parses them fine.
export function buildFrontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return ["---", ...lines, "---"].join("\n");
}

export function buildMarkdownDocument(data: MirrorBookmarkData): string {
  const sections: string[] = [];

  sections.push(
    buildFrontmatter({
      id: data.id,
      type: data.type,
      title: data.title,
      url: data.url,
      tags: data.tags,
      lists: data.lists,
      archived: data.archived,
      favourited: data.favourited,
      created: data.createdAt,
      modified: data.modifiedAt,
    }),
  );

  if (data.title) {
    sections.push(`# ${data.title}`);
  }
  if (data.summary) {
    sections.push(`> ${data.summary}`);
  }
  if (data.content) {
    sections.push(data.content);
  }

  if (data.highlights.length > 0) {
    const quoteBlocks = data.highlights.map((h) => {
      const lines = [`> ${h.text ?? ""}`];
      if (h.note) {
        lines.push(">", `> **Note:** ${h.note}`);
      }
      return lines.join("\n");
    });
    sections.push(["## Highlights", ...quoteBlocks].join("\n\n"));
  }

  if (data.note) {
    sections.push(`## Note\n\n${data.note}`);
  }

  return sections.join("\n\n") + "\n";
}

// Resolves "Parent/Child" style paths, guarding against cycles.
function buildListPath(
  listId: string,
  listsById: Map<string, { name: string; parentId: string | null }>,
): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = listsById.get(listId);
  while (current && !seen.has(listId)) {
    seen.add(listId);
    parts.unshift(current.name);
    if (!current.parentId) {
      break;
    }
    listId = current.parentId;
    current = listsById.get(listId);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

// ── Vault index page ──────────────────────────────────────────────────
// A per-user index.md at export/{userId}/index.md that groups every
// bookmark by list / unfiled / archived and links everything with
// Obsidian wikilinks, so the exported folder works as a navigable vault.

export interface IndexBookmarkEntry {
  id: string;
  title: string | null;
  archived: boolean;
  lists: string[];
  tags: string[];
}

export interface IndexConceptEntry {
  slug: string;
  title: string;
}

function indexEntryLink(id: string, title: string | null): string {
  return title ? `[[${id}|${title}]]` : `[[${id}]]`;
}

export function buildIndexDocument(
  bookmarkEntries: IndexBookmarkEntry[],
  conceptEntries: IndexConceptEntry[],
): string {
  const sections: string[] = [];
  sections.push(buildFrontmatter({ type: "index" }));
  sections.push("# Index");

  if (conceptEntries.length > 0) {
    const conceptLines = conceptEntries.map(
      (c) => `- [[${c.slug}|${c.title}]]`,
    );
    sections.push(["## Concept Pages", ...conceptLines].join("\n"));
  }

  const active = bookmarkEntries.filter((b) => !b.archived);
  const archived = bookmarkEntries.filter((b) => b.archived);

  // Group active bookmarks by list path; a bookmark listed under several
  // lists intentionally appears once per group.
  const byList = new Map<string, IndexBookmarkEntry[]>();
  const unfiled: IndexBookmarkEntry[] = [];
  for (const b of active) {
    if (b.lists.length === 0) {
      unfiled.push(b);
      continue;
    }
    for (const listPath of b.lists) {
      const group = byList.get(listPath) ?? [];
      group.push(b);
      byList.set(listPath, group);
    }
  }
  if (byList.size > 0) {
    const listSections: string[] = ["## Lists"];
    for (const [listPath, group] of byList) {
      listSections.push(`### ${listPath}`);
      listSections.push(
        group.map((b) => `- ${indexEntryLink(b.id, b.title)}`).join("\n"),
      );
    }
    sections.push(listSections.join("\n\n"));
  }
  if (unfiled.length > 0) {
    sections.push(
      [
        "## Unfiled",
        ...unfiled.map((b) => `- ${indexEntryLink(b.id, b.title)}`),
      ].join("\n"),
    );
  }
  if (archived.length > 0) {
    sections.push(
      [
        "## Archived",
        ...archived.map((b) => `- ${indexEntryLink(b.id, b.title)}`),
      ].join("\n"),
    );
  }

  // Tag cloud with counts; "#tag" is clickable inside Obsidian.
  const tagCounts = new Map<string, number>();
  for (const b of bookmarkEntries) {
    for (const t of b.tags) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  if (tagCounts.size > 0) {
    const tagLines = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => `- #${tag} (${count})`);
    sections.push(["## Tags", ...tagLines].join("\n"));
  }

  return sections.join("\n\n") + "\n";
}

// Exported for the worker: delete jobs must refresh the index too.
export async function rebuildUserIndex(userId: string): Promise<void> {
  const bookmarkRows = await db.query.bookmarks.findMany({
    where: eq(bookmarks.userId, userId),
    columns: { id: true, title: true, archived: true },
    with: {
      tagsOnBookmarks: { with: { tag: { columns: { name: true } } } },
      bookmarksInLists: { columns: { listId: true } },
    },
  });
  const userLists = await db.query.bookmarkLists.findMany({
    where: eq(bookmarkLists.userId, userId),
    columns: { id: true, name: true, parentId: true },
  });
  const listsById = new Map(
    userLists.map((l) => [l.id, { name: l.name, parentId: l.parentId }]),
  );

  const bookmarkEntries: IndexBookmarkEntry[] = bookmarkRows.map((b) => ({
    id: b.id,
    title: b.title,
    archived: b.archived,
    lists: b.bookmarksInLists
      .map((bl) => buildListPath(bl.listId, listsById))
      .filter((p): p is string => !!p),
    tags: b.tagsOnBookmarks
      .map((t) => t.tag?.name)
      .filter((n): n is string => !!n),
  }));

  const conceptEntries: IndexConceptEntry[] = (
    await db.query.conceptPages.findMany({
      where: eq(conceptPages.userId, userId),
      columns: { slug: true, title: true },
    })
  ).map((c) => ({ slug: c.slug, title: c.title }));

  const doc = buildIndexDocument(bookmarkEntries, conceptEntries);
  await exportMirrorFile(serverConfig.mirrorExport.dir, userId, "index", doc);
}

async function fetchBookmarkData(
  bookmarkId: string,
): Promise<MirrorBookmarkData | null> {
  const bookmark = await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, bookmarkId),
    with: {
      link: { columns: { url: true, htmlContent: true } },
      text: { columns: { text: true, sourceUrl: true } },
      asset: { columns: { content: true, sourceUrl: true } },
      tagsOnBookmarks: { with: { tag: { columns: { name: true } } } },
      bookmarksInLists: { columns: { listId: true } },
    },
  });
  if (!bookmark) {
    return null;
  }

  const hls = await db.query.highlights.findMany({
    where: eq(highlights.bookmarkId, bookmarkId),
    orderBy: [asc(highlights.startOffset)],
  });

  const userLists = await db.query.bookmarkLists.findMany({
    where: eq(bookmarkLists.userId, bookmark.userId),
    columns: { id: true, name: true, parentId: true },
  });
  const listsById = new Map(
    userLists.map((l) => [l.id, { name: l.name, parentId: l.parentId }]),
  );

  let url: string | null = null;
  let content: string | null = null;
  switch (bookmark.type) {
    case BookmarkTypes.LINK:
      url = bookmark.link?.url ?? null;
      content = bookmark.link?.htmlContent
        ? htmlToMarkdown(bookmark.link.htmlContent)
        : null;
      break;
    case BookmarkTypes.TEXT:
      // Notes are already authored in Markdown (Lexical serialization)
      url = bookmark.text?.sourceUrl ?? null;
      content = bookmark.text?.text ?? null;
      break;
    case BookmarkTypes.ASSET:
      url = bookmark.asset?.sourceUrl ?? null;
      content = bookmark.asset?.content ?? null;
      break;
  }

  return {
    id: bookmark.id,
    userId: bookmark.userId,
    type: bookmark.type,
    title: bookmark.title,
    url,
    summary: bookmark.summary,
    note: bookmark.note,
    archived: bookmark.archived,
    favourited: bookmark.favourited,
    createdAt: bookmark.dbCreatedAt,
    modifiedAt: bookmark.modifiedAt,
    tags: bookmark.tagsOnBookmarks
      .map((t) => t.tag?.name)
      .filter((n): n is string => !!n),
    lists: bookmark.bookmarksInLists
      .map((b) => buildListPath(b.listId, listsById))
      .filter((p): p is string => !!p),
    content,
    highlights: hls.map((h) => ({ text: h.text, note: h.note })),
  };
}

// Writes the file unless the content is unchanged. Returns true when the file
// was written, false when it was skipped.
export async function exportMirrorFile(
  rootDir: string,
  userId: string,
  bookmarkId: string,
  content: string,
): Promise<boolean> {
  const filePath = mirrorFilePath(rootDir, userId, bookmarkId);
  try {
    const existing = await fsp.readFile(filePath, "utf8");
    if (existing === content) {
      return false;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, "utf8");
  return true;
}

export async function deleteMirrorFile(
  rootDir: string,
  userId: string,
  bookmarkId: string,
): Promise<void> {
  const filePath = mirrorFilePath(rootDir, userId, bookmarkId);
  try {
    await fsp.unlink(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
}

export async function exportBookmarkMirror(
  bookmarkId: string,
  opts: { rebuildIndex?: boolean } = {},
): Promise<"exported" | "unchanged" | "missing"> {
  const data = await fetchBookmarkData(bookmarkId);
  if (!data) {
    return "missing";
  }
  const doc = buildMarkdownDocument(data);
  const written = await exportMirrorFile(
    serverConfig.mirrorExport.dir,
    data.userId,
    bookmarkId,
    doc,
  );
  // The index references every bookmark, so refresh it whenever a mirror
  // file actually changed. Skip during full rebuilds (one refresh at the end).
  if (written && opts.rebuildIndex !== false) {
    await rebuildUserIndex(data.userId);
  }
  return written ? "exported" : "unchanged";
}

// Full re-export for a user: rewrites every bookmark file and removes
// mirror files whose bookmark no longer exists. Also acts as the
// reconciliation path for any lost delete jobs.
export async function rebuildUserMirror(userId: string): Promise<{
  exported: number;
  removed: number;
}> {
  const rows = await db.query.bookmarks.findMany({
    where: eq(bookmarks.userId, userId),
    columns: { id: true },
  });

  let exported = 0;
  const keepIds = new Set<string>();
  for (const row of rows) {
    keepIds.add(row.id);
    const result = await exportBookmarkMirror(row.id, {
      rebuildIndex: false,
    });
    if (result === "exported") {
      exported++;
    }
  }

  // Concept pages mirror alongside bookmarks
  const conceptRows = await db.query.conceptPages.findMany({
    where: eq(conceptPages.userId, userId),
    columns: { id: true, slug: true },
  });
  const keepSlugs = new Set<string>();
  for (const row of conceptRows) {
    const result = await exportConceptMirror(row.id, {
      rebuildIndex: false,
    });
    if (result === "exported") {
      exported++;
    }
    keepSlugs.add(row.slug);
  }

  const removed =
    (await removeOrphanedFiles(
      serverConfig.mirrorExport.dir,
      userId,
      keepIds,
    )) +
    (await removeOrphanedConceptFiles(
      serverConfig.mirrorExport.dir,
      userId,
      keepSlugs,
    ));
  // One index refresh for the whole rebuild (individual exports skipped it).
  await rebuildUserIndex(userId);
  logger.info(
    `[mirrorExport] Rebuild for user ${userId} done: ${rows.length} bookmarks, ${conceptRows.length} concepts, ${exported} written, ${removed} orphaned files removed`,
  );
  return { exported, removed };
}

// ── Concept page mirror ────────────────────────────────────────────────
// Concept pages live under export/{userId}/concepts/{slug}.md and link back
// to their source bookmarks via relative paths, wiki-style.

export function conceptFilePath(
  rootDir: string,
  userId: string,
  slug: string,
): string {
  return path.join(rootDir, userId, "concepts", `${slug}.md`);
}

export interface MirrorConceptSource {
  bookmarkId: string;
  title: string | null;
  url: string | null;
}

export interface MirrorConceptData {
  id: string;
  title: string;
  anchorType: "tag" | "list";
  anchorName: string | null;
  status: string;
  content: string;
  lastCompiledAt: Date | null;
  createdAt: Date | null;
  sources: MirrorConceptSource[];
}

export function buildConceptMarkdownDocument(data: MirrorConceptData): string {
  const sections: string[] = [];

  sections.push(
    buildFrontmatter({
      id: data.id,
      type: "concept",
      title: data.title,
      anchor: data.anchorName
        ? { type: data.anchorType, name: data.anchorName }
        : { type: data.anchorType },
      sources: data.sources.map((s) => `../${s.bookmarkId}.md`),
      status: data.status,
      compiled: data.lastCompiledAt,
      created: data.createdAt,
    }),
  );

  sections.push(`# ${data.title}`);
  sections.push(data.content || "_（尚未编译）_");

  if (data.sources.length > 0) {
    // Obsidian wikilink with display alias: [[{bookmarkId}|{title}]]. The
    // mirror files are named by bookmark id, so the link target is stable
    // while the alias stays human-readable.
    const sourceLines = data.sources.map(
      (s, i) =>
        `${i + 1}. ${s.title ? `[[${s.bookmarkId}|${s.title}]]` : `[[${s.bookmarkId}]]`}${s.url ? ` — ${s.url}` : ""}`,
    );
    sections.push(["## Sources", ...sourceLines].join("\n"));
  }

  return sections.join("\n\n") + "\n";
}

async function fetchConceptData(
  conceptId: string,
): Promise<(MirrorConceptData & { slug: string; userId: string }) | null> {
  const page = await db.query.conceptPages.findFirst({
    where: eq(conceptPages.id, conceptId),
  });
  if (!page) {
    return null;
  }

  const anchorName = await resolveAnchorName(
    page.userId,
    page.anchorType,
    page.anchorId,
  );

  const sourceRows = await db.query.conceptPageSources.findMany({
    where: eq(conceptPageSources.pageId, conceptId),
    columns: { bookmarkId: true },
    with: {
      bookmark: {
        columns: { id: true, title: true },
        with: { link: { columns: { url: true } } },
      },
    },
  });

  return {
    id: page.id,
    userId: page.userId,
    slug: page.slug,
    title: page.title,
    anchorType: page.anchorType,
    anchorName,
    status: page.status,
    content: page.content,
    lastCompiledAt: page.lastCompiledAt,
    createdAt: page.createdAt,
    sources: sourceRows
      .map((s): MirrorConceptSource | null =>
        s.bookmark
          ? {
              bookmarkId: s.bookmark.id,
              title: s.bookmark.title,
              url: s.bookmark.link?.url ?? null,
            }
          : null,
      )
      .filter((s): s is MirrorConceptSource => s !== null),
  };
}

async function resolveAnchorName(
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

export async function exportConceptMirror(
  conceptId: string,
  opts: { rebuildIndex?: boolean } = {},
): Promise<"exported" | "unchanged" | "missing"> {
  const data = await fetchConceptData(conceptId);
  if (!data) {
    return "missing";
  }
  const doc = buildConceptMarkdownDocument(data);
  const written = await exportMirrorFile(
    serverConfig.mirrorExport.dir,
    data.userId,
    // Reuse the bookmark writer by pointing it at the concepts subpath:
    // exportMirrorFile builds {root}/{userId}/{key}.md, so pass the
    // concepts-prefixed key directly.
    `concepts${path.sep}${data.slug}`,
    doc,
  );
  if (written && opts.rebuildIndex !== false) {
    await rebuildUserIndex(data.userId);
  }
  return written ? "exported" : "unchanged";
}

export async function deleteConceptMirrorFile(
  rootDir: string,
  userId: string,
  slug: string,
): Promise<void> {
  const filePath = conceptFilePath(rootDir, userId, slug);
  try {
    await fsp.unlink(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
}

async function removeOrphanedConceptFiles(
  rootDir: string,
  userId: string,
  keepSlugs: Set<string>,
): Promise<number> {
  const conceptsDir = path.join(rootDir, userId, "concepts");
  let entries: string[];
  try {
    entries = await fsp.readdir(conceptsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const slug = entry.slice(0, -".md".length);
    if (!keepSlugs.has(slug)) {
      await fsp.unlink(path.join(conceptsDir, entry));
      removed++;
    }
  }
  return removed;
}

async function removeOrphanedFiles(
  rootDir: string,
  userId: string,
  keepIds: Set<string>,
): Promise<number> {
  const userDir = path.join(rootDir, userId);
  let entries: string[];
  try {
    entries = await fsp.readdir(userDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    // index.md is generated, not a bookmark mirror — never treat as orphan.
    if (entry === "index.md") {
      continue;
    }
    const id = entry.slice(0, -".md".length);
    if (!keepIds.has(id)) {
      await fsp.unlink(path.join(userDir, entry));
      removed++;
    }
  }
  return removed;
}
