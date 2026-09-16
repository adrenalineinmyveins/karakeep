import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { DB } from "@saiye/db";
import {
  bookmarkLists,
  bookmarkTags,
  conceptPageSources,
  conceptPages,
} from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";
import {
  triggerConceptCompilation,
  triggerConceptMirrorDelete,
} from "@saiye/shared-server";

import { authedProcedure, createRateLimitMiddleware, router } from "../index";

const zConceptStatusSchema = z.enum([
  "pending",
  "generating",
  "ready",
  "stale",
  "failure",
]);

const zAnchorInputSchema = z.object({
  anchorType: z.enum(["tag", "list"]),
  anchorId: z.string(),
});

async function fetchAnchor(
  db: DB,
  userId: string,
  anchorType: "tag" | "list",
  anchorId: string,
) {
  if (anchorType === "tag") {
    return db.query.bookmarkTags.findFirst({
      where: and(
        eq(bookmarkTags.id, anchorId),
        eq(bookmarkTags.userId, userId),
      ),
      columns: { id: true, name: true },
    });
  }
  return db.query.bookmarkLists.findFirst({
    where: and(
      eq(bookmarkLists.id, anchorId),
      eq(bookmarkLists.userId, userId),
    ),
    columns: { id: true, name: true },
  });
}

// Unicode-aware slug: keeps CJK/letters/digits, collapses everything else to
// dashes. Falls back to "concept" when nothing survives.
function slugify(name: string): string {
  const base = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "concept";
}

const zConceptPageSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  anchorType: z.enum(["tag", "list"]),
  anchorId: z.string(),
  status: zConceptStatusSchema,
  lastError: z.string().nullable(),
  sourceCount: z.number(),
  compileVersion: z.number(),
  lastCompiledAt: z.date().nullable(),
  createdAt: z.date().nullable(),
});

export const conceptsAppRouter = router({
  // Overview list for the concepts dashboard page
  list: authedProcedure
    .output(z.object({ concepts: z.array(zConceptPageSummarySchema) }))
    .query(async ({ ctx }) => {
      const rows = await ctx.db.query.conceptPages.findMany({
        where: eq(conceptPages.userId, ctx.user.id),
        columns: {
          id: true,
          title: true,
          slug: true,
          anchorType: true,
          anchorId: true,
          status: true,
          lastError: true,
          sourceCount: true,
          compileVersion: true,
          lastCompiledAt: true,
          createdAt: true,
        },
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
      return { concepts: rows };
    }),

  // Detail view: compiled content + source bookmarks
  get: authedProcedure
    .input(z.object({ slug: z.string() }))
    .output(
      z.object({
        concept: zConceptPageSummarySchema,
        content: z.string(),
        anchorName: z.string().nullable(),
        sources: z.array(
          z.object({
            bookmarkId: z.string(),
            title: z.string().nullable(),
            url: z.string().nullable(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = await ctx.db.query.conceptPages.findFirst({
        where: and(
          eq(conceptPages.userId, ctx.user.id),
          eq(conceptPages.slug, input.slug),
        ),
      });
      if (!page) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Concept not found",
        });
      }

      const anchor = await fetchAnchor(
        ctx.db,
        ctx.user.id,
        page.anchorType,
        page.anchorId,
      );

      const sources = await ctx.db.query.conceptPageSources.findMany({
        where: eq(conceptPageSources.pageId, page.id),
        columns: { bookmarkId: true },
        with: {
          bookmark: {
            columns: { id: true, title: true },
            with: { link: { columns: { url: true } } },
          },
        },
      });

      return {
        concept: {
          id: page.id,
          title: page.title,
          slug: page.slug,
          anchorType: page.anchorType,
          anchorId: page.anchorId,
          status: page.status,
          lastError: page.lastError,
          sourceCount: page.sourceCount,
          compileVersion: page.compileVersion,
          lastCompiledAt: page.lastCompiledAt,
          createdAt: page.createdAt,
        },
        content: page.content,
        anchorName: anchor?.name ?? null,
        sources: sources
          .map((s) =>
            s.bookmark
              ? {
                  bookmarkId: s.bookmark.id,
                  title: s.bookmark.title,
                  url: s.bookmark.link?.url ?? null,
                }
              : null,
          )
          .filter((s): s is NonNullable<typeof s> => !!s),
      };
    }),

  // Status of a specific anchor for the inline entry card on tag/list pages
  anchorStatus: authedProcedure
    .input(zAnchorInputSchema)
    .output(
      z.object({
        conceptId: z.string().nullable(),
        slug: z.string().nullable(),
        status: zConceptStatusSchema.nullable(),
        sourceCount: z.number().nullable(),
        lastCompiledAt: z.date().nullable(),
        lastError: z.string().nullable(),
        inferenceConfigured: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = await ctx.db.query.conceptPages.findFirst({
        where: and(
          eq(conceptPages.userId, ctx.user.id),
          eq(conceptPages.anchorType, input.anchorType),
          eq(conceptPages.anchorId, input.anchorId),
        ),
        columns: {
          id: true,
          slug: true,
          status: true,
          sourceCount: true,
          lastCompiledAt: true,
          lastError: true,
        },
      });
      return {
        conceptId: page?.id ?? null,
        slug: page?.slug ?? null,
        status: page?.status ?? null,
        sourceCount: page?.sourceCount ?? null,
        lastCompiledAt: page?.lastCompiledAt ?? null,
        lastError: page?.lastError ?? null,
        inferenceConfigured: serverConfig.inference.isConfigured,
      };
    }),

  // Create a concept page for an anchor and queue the first compile
  create: authedProcedure
    .input(zAnchorInputSchema)
    .output(
      z.object({
        conceptId: z.string(),
        slug: z.string(),
        status: zConceptStatusSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!serverConfig.inference.isConfigured) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Inference is not configured",
        });
      }
      const anchor = await fetchAnchor(
        ctx.db,
        ctx.user.id,
        input.anchorType,
        input.anchorId,
      );
      if (!anchor) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Anchor not found",
        });
      }

      const existing = await ctx.db.query.conceptPages.findFirst({
        where: and(
          eq(conceptPages.userId, ctx.user.id),
          eq(conceptPages.anchorType, input.anchorType),
          eq(conceptPages.anchorId, input.anchorId),
        ),
        columns: { id: true },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A concept page already exists for this anchor",
        });
      }

      // Slug collisions (two anchors with the same name) get a suffix
      let slug = slugify(anchor.name);
      const slugTaken = await (async (s: string) =>
        !!(await ctx.db.query.conceptPages.findFirst({
          where: and(
            eq(conceptPages.userId, ctx.user.id),
            eq(conceptPages.slug, s),
          ),
          columns: { id: true },
        })))(slug);
      if (slugTaken) {
        slug = `${slug}-${Math.random().toString(36).slice(2, 8)}`;
      }

      const inserted = await ctx.db
        .insert(conceptPages)
        .values({
          userId: ctx.user.id,
          anchorType: input.anchorType,
          anchorId: input.anchorId,
          title: anchor.name,
          slug,
          status: "pending",
        })
        .returning({ id: conceptPages.id, slug: conceptPages.slug });

      await triggerConceptCompilation(inserted[0].id);
      return {
        conceptId: inserted[0].id,
        slug: inserted[0].slug,
        status: "pending" as const,
      };
    }),

  // Queue a re-compile for an existing page
  recompile: authedProcedure
    .input(z.object({ conceptId: z.string() }))
    .use(
      createRateLimitMiddleware({
        name: "concepts.recompile",
        windowMs: 60 * 60 * 1000,
        maxRequests: 20,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const page = await ctx.db.query.conceptPages.findFirst({
        where: and(
          eq(conceptPages.id, input.conceptId),
          eq(conceptPages.userId, ctx.user.id),
        ),
        columns: { id: true, status: true },
      });
      if (!page) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Concept not found",
        });
      }
      if (page.status === "generating") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Compilation already in progress",
        });
      }
      await ctx.db
        .update(conceptPages)
        .set({ status: "pending", lastError: null })
        .where(eq(conceptPages.id, input.conceptId));
      await triggerConceptCompilation(input.conceptId);
    }),

  // Delete a page (bookmarks are untouched; the page can always be recreated)
  delete: authedProcedure
    .input(z.object({ conceptId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const page = await ctx.db.query.conceptPages.findFirst({
        where: and(
          eq(conceptPages.id, input.conceptId),
          eq(conceptPages.userId, ctx.user.id),
        ),
        columns: { id: true, slug: true },
      });
      if (!page) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Concept not found",
        });
      }
      await ctx.db.delete(conceptPages).where(eq(conceptPages.id, page.id));
      await triggerConceptMirrorDelete(ctx.user.id, page.slug);
    }),
});
