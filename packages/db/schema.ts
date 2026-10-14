import type { AdapterAccount } from "@auth/core/adapters";
import { createId } from "@paralleldrive/cuid2";
import { relations, sql, SQL } from "drizzle-orm";
import {
  AnyPgColumn,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { ZApiKeyScope } from "@saiye/shared/types/apiKeys";
import { API_KEY_FULL_ACCESS_SCOPE } from "@saiye/shared/types/apiKeys";
import type {
  AgentNurtureState,
  AgentOnlineState,
  KnowledgeScope,
} from "@saiye/shared/types/agentProfiles";
import type {
  SkillParam,
  SkillToolGrant,
} from "@saiye/shared/types/agentSkills";
import { BookmarkTypes } from "@saiye/shared/types/bookmarks";
import type { ZReaderViewReason } from "@saiye/shared/types/bookmarks";

function createdAtField(colName = "createdAt") {
  return timestamp(colName, { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date());
}

function createdAtMsField() {
  return timestamp("createdAt", { withTimezone: true })
    .notNull()
    .$defaultFn(() => new Date());
}

function modifiedAtField() {
  return timestamp("modifiedAt", { withTimezone: true })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());
}

function modifiedAtMsField() {
  return timestamp("modifiedAt", { withTimezone: true })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());
}

export const users = pgTable("user", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("emailVerified", { withTimezone: true }),
  image: text("image"),
  password: text("password"),
  salt: text("salt").notNull().default(""),
  role: text("role", { enum: ["admin", "user"] }).default("user"),

  // Admin Only Settings
  bookmarkQuota: integer("bookmarkQuota"),
  storageQuota: integer("storageQuota"),
  browserCrawlingEnabled: boolean("browserCrawlingEnabled"),
  // Admin-granted plan label (e.g. a collaborator name). While set, Stripe
  // sync doesn't downgrade the user's entitlements; it's cleared when the
  // user gets an active Stripe subscription.
  manualTierName: text("manualTierName"),
  // Credits 钱包余额（creditsTransactions.SUM(delta) 的冗余缓存；权威来源）
  creditsBalance: integer("creditsBalance").notNull().default(0),

  // User Settings
  bookmarkClickAction: text("bookmarkClickAction", {
    enum: ["open_original_link", "expand_bookmark_preview"],
  })
    .notNull()
    .default("open_original_link"),
  archiveDisplayBehaviour: text("archiveDisplayBehaviour", {
    enum: ["show", "hide"],
  })
    .notNull()
    .default("show"),
  timezone: text("timezone").default("UTC"),

  // Backup Settings
  backupsEnabled: boolean("backupsEnabled").notNull().default(false),
  backupsFrequency: text("backupsFrequency", {
    enum: ["daily", "weekly"],
  })
    .notNull()
    .default("weekly"),
  backupsRetentionDays: integer("backupsRetentionDays").notNull().default(30),

  // Reader view settings (nullable = opt-in, null means use client default)
  readerFontSize: integer("readerFontSize"),
  readerLineHeight: real("readerLineHeight"),
  readerFontFamily: text("readerFontFamily", {
    enum: ["serif", "sans", "mono"],
  }),

  // AI Settings (nullable = opt-in, null means use server default)
  autoTaggingEnabled: boolean("autoTaggingEnabled"),
  autoSummarizationEnabled: boolean("autoSummarizationEnabled"),
  // Chat knowledge context injection (nullable = default ON, null means enabled)
  chatKnowledgeContextEnabled: boolean("chatKnowledgeContextEnabled"),
  tagStyle: text("tagStyle", {
    enum: [
      "lowercase-hyphens",
      "lowercase-spaces",
      "lowercase-underscores",
      "titlecase-spaces",
      "titlecase-hyphens",
      "camelCase",
      "as-generated",
    ],
  }).default("titlecase-spaces"),
  curatedTagIds: jsonb("curatedTagIds").$type<string[]>(),
  inferredTagLang: text("inferredTagLang"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccount["type"]>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  ],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

export const passwordResetTokens = pgTable(
  "passwordResetToken",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
    createdAt: createdAtField(),
  },
  (prt) => [index("passwordResetTokens_userId_idx").on(prt.userId)],
);

export const apiKeys = pgTable(
  "apiKey",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    createdAt: createdAtField(),
    lastUsedAt: timestamp("lastUsedAt", { withTimezone: true }),
    keyId: text("keyId").notNull().unique(),
    keyHash: text("keyHash").notNull(),
    scopes: jsonb("scopes")
      .$type<ZApiKeyScope[]>()
      .notNull()
      .$defaultFn(() => [API_KEY_FULL_ACCESS_SCOPE]),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (ak) => [unique().on(ak.name, ak.userId)],
);

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    // The `createdAt` field and the `createdAt` column intentionally don't
    // match. Re-saving an existing bookmark bumps it back to the top of the
    // list, so the timestamp everything sorts and filters on is now "when was
    // this last saved" and lives in the `lastSavedAt` column. It keeps the
    // `createdAt` field name because that's what the API has always exposed and
    // what every query already orders by. The immutable "when did this row
    // first appear" timestamp stays in the original `createdAt` column, and is
    // exposed to clients as `firstCreatedAt`.
    dbCreatedAt: createdAtField(),
    createdAt: createdAtField("lastSavedAt"),
    modifiedAt: modifiedAtField(),
    title: text("title"),
    archived: boolean("archived").notNull().default(false),
    favourited: boolean("favourited").notNull().default(false),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taggingStatus: text("taggingStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    summarizationStatus: text("summarizationStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    embeddingStatus: text("embeddingStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    summary: text("summary"),
    note: text("note"),
    type: text("type", {
      enum: [BookmarkTypes.LINK, BookmarkTypes.TEXT, BookmarkTypes.ASSET],
    }).notNull(),
    source: text("source", {
      enum: [
        "api",
        "web",
        "extension",
        "cli",
        "mobile",
        "singlefile",
        "rss",
        "import",
      ],
    }),
  },
  (b) => [
    index("bookmarks_lastSavedAt_idx").on(b.createdAt),
    // Composite indexes for optimized pagination queries
    index("bookmarks_userId_lastSavedAt_id_idx").on(
      b.userId,
      b.createdAt,
      b.id,
    ),
    index("bookmarks_userId_archived_lastSavedAt_id_idx").on(
      b.userId,
      b.archived,
      b.createdAt,
      b.id,
    ),
    index("bookmarks_userId_favourited_lastSavedAt_id_idx").on(
      b.userId,
      b.favourited,
      b.createdAt,
      b.id,
    ),
  ],
);

export const bookmarkLinks = pgTable(
  "bookmarkLinks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId())
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    url: text("url").notNull(),

    // Crawled info
    title: text("title"),
    description: text("description"),
    author: text("author"),
    publisher: text("publisher"),
    datePublished: timestamp("datePublished", { withTimezone: true }),
    dateModified: timestamp("dateModified", { withTimezone: true }),
    imageUrl: text("imageUrl"),
    favicon: text("favicon"),
    htmlContent: text("htmlContent"),
    contentAssetId: text("contentAssetId"),
    readerViewStatus: text("readerViewStatus", {
      enum: ["readable", "not_readable", "uncertain", "unavailable"],
    }),
    readerViewScore: integer("readerViewScore"),
    readerViewReasons: jsonb("readerViewReasons").$type<ZReaderViewReason[]>(),
    readerViewClassifierVersion: integer("readerViewClassifierVersion"),
    crawledAt: timestamp("crawledAt", { withTimezone: true }),
    crawlStatus: text("crawlStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    crawlStatusCode: integer("crawlStatusCode").default(200),
    // When the pre-crawl probe last extracted and stored this link's metadata.
    // Lets crawl retries skip re-fetching it.
    probeMetadataAt: timestamp("probeMetadataAt", { withTimezone: true }),
  },
  (bl) => [index("bookmarkLinks_url_idx").on(bl.url)],
);

export const enum AssetTypes {
  LINK_BANNER_IMAGE = "linkBannerImage",
  LINK_SCREENSHOT = "linkScreenshot",
  LINK_PDF = "linkPdf",
  ASSET_SCREENSHOT = "assetScreenshot",
  LINK_FULL_PAGE_ARCHIVE = "linkFullPageArchive",
  LINK_PRECRAWLED_ARCHIVE = "linkPrecrawledArchive",
  LINK_VIDEO = "linkVideo",
  LINK_HTML_CONTENT = "linkHtmlContent",
  BOOKMARK_ASSET = "bookmarkAsset",
  USER_UPLOADED = "userUploaded",
  AVATAR = "avatar",
  BACKUP = "backup",
  UNKNOWN = "unknown",
}

export const assets = pgTable(
  "assets",
  {
    // Asset ids don't have a default function as they are generated by the caller
    id: text("id").notNull().primaryKey(),
    assetType: text("assetType", {
      enum: [
        AssetTypes.LINK_BANNER_IMAGE,
        AssetTypes.LINK_SCREENSHOT,
        AssetTypes.LINK_PDF,
        AssetTypes.ASSET_SCREENSHOT,
        AssetTypes.LINK_FULL_PAGE_ARCHIVE,
        AssetTypes.LINK_PRECRAWLED_ARCHIVE,
        AssetTypes.LINK_VIDEO,
        AssetTypes.LINK_HTML_CONTENT,
        AssetTypes.BOOKMARK_ASSET,
        AssetTypes.USER_UPLOADED,
        AssetTypes.AVATAR,
        AssetTypes.BACKUP,
        AssetTypes.UNKNOWN,
      ],
    }).notNull(),
    size: integer("size").notNull().default(0),
    contentType: text("contentType"),
    fileName: text("fileName"),
    bookmarkId: text("bookmarkId").references(() => bookmarks.id, {
      onDelete: "cascade",
    }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },

  (tb) => [
    index("assets_bookmarkId_idx").on(tb.bookmarkId),
    index("assets_assetType_idx").on(tb.assetType),
    index("assets_userId_idx").on(tb.userId),
  ],
);

export const highlights = pgTable(
  "highlights",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, {
        onDelete: "cascade",
      }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startOffset: integer("startOffset").notNull(),
    endOffset: integer("endOffset").notNull(),
    color: text("color", {
      enum: ["red", "green", "blue", "yellow"],
    })
      .default("yellow")
      .notNull(),
    text: text("text"),
    note: text("note"),
    createdAt: createdAtField(),
  },
  (tb) => [
    index("highlights_bookmarkId_idx").on(tb.bookmarkId),
    index("highlights_userId_idx").on(tb.userId),
  ],
);

// Concept pages: LLM-compiled knowledge digests anchored on a tag or a list.
// The database stays the single source of truth; the compiled markdown is also
// mirrored to export/{userId}/concepts/{slug}.md by the mirror export worker.
// anchorId intentionally has no FK: it points at either bookmarkTags.id or
// bookmarkLists.id. Orphaned anchors (tag/list deleted) are cleaned up by the
// periodic reconciliation cron.
export const conceptPages = pgTable(
  "conceptPages",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    anchorType: text("anchorType", { enum: ["tag", "list"] }).notNull(),
    anchorId: text("anchorId").notNull(),

    title: text("title").notNull(),
    // Stable file name for the markdown mirror (unique per user)
    slug: text("slug").notNull(),

    // Markdown body produced by the LLM. Kept on stale/failure so the page
    // always stays readable; only replaced after a successful compile.
    content: text("content").notNull().default(""),

    status: text("status", {
      enum: ["pending", "generating", "ready", "stale", "failure"],
    })
      .notNull()
      .default("pending"),
    lastError: text("lastError"),

    // Snapshot of the source set used for the current compile, used for
    // stale detection during the reconciliation cron.
    sourceCount: integer("sourceCount").notNull().default(0),
    sourceContentHash: text("sourceContentHash"),

    compileVersion: integer("compileVersion").notNull().default(0),
    lastCompiledAt: timestamp("lastCompiledAt", { withTimezone: true }),
    lastSourceChangeAt: modifiedAtField(),

    createdAt: createdAtField(),
  },
  (tb) => [
    unique().on(tb.userId, tb.anchorType, tb.anchorId),
    unique().on(tb.userId, tb.slug),
    index("conceptPages_userId_status_idx").on(tb.userId, tb.status),
  ],
);

// Which bookmarks were fed into a concept page compile. Bookmark deletion
// cascades rows away here; the reconciliation cron notices the mismatch with
// conceptPages.sourceCount and marks the page stale.
export const conceptPageSources = pgTable(
  "conceptPageSources",
  {
    pageId: text("pageId")
      .notNull()
      .references(() => conceptPages.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    attachedAt: timestamp("attachedAt", { withTimezone: true }).$defaultFn(
      () => new Date(),
    ),
  },
  (tb) => [
    primaryKey({ columns: [tb.pageId, tb.bookmarkId] }),
    index("conceptPageSources_bookmarkId_idx").on(tb.bookmarkId),
  ],
);

export const userReadingProgress = pgTable(
  "userReadingProgress",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, {
        onDelete: "cascade",
      }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readingProgressOffset: integer("readingProgressOffset").notNull(),
    readingProgressAnchor: text("readingProgressAnchor"),
    readingProgressPercent: integer("readingProgressPercent"),
    modifiedAt: modifiedAtField(),
  },
  (tb) => [
    unique().on(tb.bookmarkId, tb.userId),
    index("userReadingProgress_bookmarkId_idx").on(tb.bookmarkId),
    index("userReadingProgress_userId_idx").on(tb.userId),
  ],
);

export const bookmarkTexts = pgTable("bookmarkTexts", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId())
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  text: text("text"),
  sourceUrl: text("sourceUrl"),
});

export const bookmarkAssets = pgTable("bookmarkAssets", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId())
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  assetType: text("assetType", { enum: ["image", "audio", "pdf"] }).notNull(),
  assetId: text("assetId").notNull(),
  content: text("content"),
  metadata: text("metadata"),
  fileName: text("fileName"),
  sourceUrl: text("sourceUrl"),
});

export const bookmarkTags = pgTable(
  "bookmarkTags",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    normalizedName: text("normalizedName").generatedAlwaysAs(
      (): SQL =>
        // This function needs to be in sync with the tagNormalizer function in tagging.ts
        // PG generated 列默认 stored（lower/replace 均 immutable，合法）
        sql`lower(replace(replace(replace(${bookmarkTags.name}, ' ', ''), '-', ''), '_', ''))`,
    ),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bt) => [
    unique().on(bt.userId, bt.name),
    unique("bookmarkTags_userId_id_idx").on(bt.userId, bt.id),
    index("bookmarkTags_name_idx").on(bt.name),
    index("bookmarkTags_normalizedName_idx").on(bt.normalizedName),
  ],
);

export const tagsOnBookmarks = pgTable(
  "tagsOnBookmarks",
  {
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    tagId: text("tagId")
      .notNull()
      .references(() => bookmarkTags.id, { onDelete: "cascade" }),

    attachedAt: timestamp("attachedAt", { withTimezone: true }).$defaultFn(
      () => new Date(),
    ),
    attachedBy: text("attachedBy", { enum: ["ai", "human"] }).notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.bookmarkId, tb.tagId] }),
    // Composite index for tag-first queries (when filtering by tagId)
    index("tagsOnBookmarks_tagId_bookmarkId_idx").on(tb.tagId, tb.bookmarkId),
  ],
);

export const bookmarkLists = pgTable(
  "bookmarkLists",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon").notNull(),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["manual", "smart"] }).notNull(),
    // Only applicable for smart lists
    query: text("query"),
    parentId: text("parentId").references((): AnyPgColumn => bookmarkLists.id, {
      onDelete: "set null",
    }),
    // Whoever have access to this token can read the content of this list
    rssToken: text("rssToken"),
    public: boolean("public").notNull().default(false),
  },
  (bl) => [
    index("bookmarkLists_userId_idx").on(bl.userId),
    unique("bookmarkLists_userId_id_idx").on(bl.userId, bl.id),
  ],
);

export const bookmarksInLists = pgTable(
  "bookmarksInLists",
  {
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    addedAt: timestamp("addedAt", { withTimezone: true }).$defaultFn(
      () => new Date(),
    ),
    // Tie the list's existence to the user's membership
    // of this list.
    listMembershipId: text("listMembershipId").references(
      () => listCollaborators.id,
      {
        onDelete: "cascade",
      },
    ),
  },
  (tb) => [
    primaryKey({ columns: [tb.bookmarkId, tb.listId] }),
    // Composite index for list-first queries (when filtering by listId)
    index("bookmarksInLists_listId_bookmarkId_idx").on(
      tb.listId,
      tb.bookmarkId,
    ),
  ],
);

export const listCollaborators = pgTable(
  "listCollaborators",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    addedAt: createdAtField(),
    addedBy: text("addedBy").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (lc) => [
    unique().on(lc.listId, lc.userId),
    index("listCollaborators_listId_idx").on(lc.listId),
    index("listCollaborators_userId_idx").on(lc.userId),
  ],
);

export const listInvitations = pgTable(
  "listInvitations",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    status: text("status", { enum: ["pending", "declined"] })
      .notNull()
      .default("pending"),
    invitedAt: timestamp("invitedAt", { withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    invitedEmail: text("invitedEmail"),
    invitedBy: text("invitedBy").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (li) => [
    unique().on(li.listId, li.userId),
    index("listInvitations_listId_idx").on(li.listId),
    index("listInvitations_userId_idx").on(li.userId),
    index("listInvitations_status_idx").on(li.status),
  ],
);

export const customPrompts = pgTable(
  "customPrompts",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    text: text("text").notNull(),
    enabled: boolean("enabled").notNull(),
    appliesTo: text("appliesTo", {
      enum: ["all_tagging", "text", "images", "summary"],
    }).notNull(),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bl) => [index("customPrompts_userId_idx").on(bl.userId)],
);

/**
 * Agent 档案：用户可配置的外部 agent / OpenAI 兼容端点。
 * - openai-compatible：baseUrl + apiKey + model（pi-ai 每档案独立 provider）
 * - trae-cli：command + timeoutMinutes（CLI 子进程 adapter）
 */
export const agentProfiles = pgTable(
  "agentProfiles",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // hosted = 宿主型个人 Agent：大脑由平台推理承担（无外部连接字段）
    type: text("type", {
      enum: ["openai-compatible", "trae-cli", "hosted"],
    }).notNull(),
    baseUrl: text("baseUrl"),
    apiKey: text("apiKey"),
    model: text("model"),
    command: text("command"),
    timeoutMinutes: integer("timeoutMinutes").notNull().default(5),
    systemPrompt: text("systemPrompt"),
    enableTools: boolean("enableTools").notNull().default(true),
    // per-profile 语料隔离（D2-c 隐私白名单）：绑定标签/清单构成对外暴露面；
    // null 或两者皆空 = 本人会话用全部书签语料，对外咨询默认私有（零注入）
    knowledgeScope: jsonb("knowledge_scope").$type<KnowledgeScope | null>(),
    // 自主咨询预算授权：专家代理所有者为其代理批的预算上限（credits）。
    // 授权额度内代理可自主发起子咨询，无需人工逐项确认；
    // null/0 = 未授权（咨询工具集不暴露 consult_agent 自主咨询能力）
    consultBudget: integer("consultBudget"),
    // D2 喂养产物：LLM 自动生成 + 手工修正（nurtureAuto=false 后停自动刷新）
    bio: text("bio"),
    expertiseTags: jsonb("expertise_tags").$type<string[] | null>(),
    nurtureAuto: boolean("nurture_auto").notNull().default(true),
    // D2-b 增量游标：只处理游标之后变更的书签，避免全量轮询
    nurtureState: jsonb("nurture_state").$type<AgentNurtureState | null>(),
    // D1 在线状态：openai-compatible 探活结果（hosted 恒在线不写；trae-cli 本地运行不可探）
    onlineState: jsonb("online_state").$type<AgentOnlineState | null>(),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (ap) => [index("agentProfiles_userId_idx").on(ap.userId)],
);

// ── P1 提示词模板型技能 ──────────────────────────────
//
// 挂在 agentProfile 下的可复用提示词模板：咨询者咨询时点选技能，
// 模板正文以 <skill_directive> 块拼入当轮 prompt，指引专家按固定流程作答。
// 发布联动：publication 处于 published/delisting 时技能可被选用，下架即失效。
export const agentSkills = pgTable(
  "agentSkills",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentProfileId: text("agentProfileId")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    // 模板正文（注入当轮 prompt 的指令内容）
    promptTemplate: text("promptTemplate").notNull(),
    // 输出格式提示（拼接在模板正文之后，可空）
    outputHint: text("outputHint"),
    // P3 参数化技能：参数定义数组（null = 无参提示词模板型）
    paramsSchema: jsonb("params_schema").$type<SkillParam[] | null>(),
    // P2 技能级语料范围：点选技能的当轮以「档案 scope ∩ 技能 scope」
    // 交集收窄检索范围；null = 不收窄（仅档案 scope）
    knowledgeScope: jsonb("knowledge_scope").$type<KnowledgeScope | null>(),
    // P4 工具执行型技能：点选技能的当轮临时解锁的工具白名单
    // （null = 纯提示词技能；执行身份=咨询者，产物归属咨询者）
    toolGrant: jsonb("tool_grant").$type<SkillToolGrant | null>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (as) => [index("agentSkills_profileId_idx").on(as.agentProfileId)],
);

// B1 长期记忆固化：agent 对话中提炼的用户偏好/事实，
// 注入三源 RAG 上下文，让 agent 越用越懂用户。
export const agentMemories = pgTable(
  "agentMemories",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    // 来源会话（可空）；不设 FK——会话删除后记忆保留
    sourceChatId: text("sourceChatId"),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (am) => [index("agentMemories_userId_idx").on(am.userId)],
);

// D6-b 动态内容池：用户为自己的 Agent 发布的短内容（发现流的组成之一）。
// publicationId 可空：关联发布时 Feed 条目可跳转对应专家卡片；
// 不设 FK——发布下架/删除后动态文本保留展示。
export const agentPosts = pgTable(
  "agentPosts",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 作者 Agent 档案（展示身份）；删除档案时动态一并清理
    profileId: text("profileId")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    // 可选关联发布（跳转专家卡片用；仅存 id 不约束）
    publicationId: text("publicationId"),
    content: text("content").notNull(),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtField(),
  },
  (ap) => [
    index("agentPosts_userId_idx").on(ap.userId),
    index("agentPosts_createdAt_idx").on(ap.createdAt),
  ],
);

// D6-a 曝光去重：feed 返回过的条目对该用户不再出现（验收：连续刷新不重复）。
// (userId, itemType, itemId) 唯一——重复曝光幂等合并。
export const feedImpressions = pgTable(
  "feedImpressions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemType: text("itemType", { enum: ["publication", "post"] }).notNull(),
    itemId: text("itemId").notNull(),
    createdAt: createdAtMsField(),
  },
  (fi) => [
    uniqueIndex("feedImpressions_unique_idx").on(
      fi.userId,
      fi.itemType,
      fi.itemId,
    ),
    index("feedImpressions_user_idx").on(fi.userId),
  ],
);

export const chatSessions = pgTable(
  "chatSessions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    title: text("title").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentProfileId: text("agentProfileId").references(() => agentProfiles.id, {
      onDelete: "set null",
    }),
    // ── D2 咨询会话维度 ──────────────────────
    // ownerUserId/publicationId 非空 = 咨询会话：userId 是咨询者，
    // ownerUserId 是领域专家所有者（知识检索按 owner、记忆隔离、按发布计量）。
    // 所有者删号时级联置空，会话退化为普通会话（档案同时被删，回退默认助手）。
    ownerUserId: text("ownerUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    publicationId: text("publicationId").references(
      () => agentPublications.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (cs) => [
    index("chatSessions_userId_idx").on(cs.userId),
    index("chatSessions_userId_modifiedAt_idx").on(cs.userId, cs.modifiedAt),
  ],
);

export const chatMessages = pgTable(
  "chatMessages",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    chatId: text("chatId")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "toolResult"] }).notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<unknown>(),
    createdAt: createdAtMsField(),
  },
  (cm) => [
    index("chatMessages_chatId_idx").on(cm.chatId),
    index("chatMessages_chatId_createdAt_idx").on(cm.chatId, cm.createdAt),
  ],
);

// ── D1 领域专家发布（跨用户咨询）──────────────────────
//
// 所有者把 agentProfile 发布为可被其他用户付费调用的「领域专家」：
// - published：正常接单
// - delisting：下架缓冲期（默认 7 天），不接新会话、已购会话继续服务、可恢复
// - delisted：彻底下架（delisting 到期后由读路径惰性转换），服务关闭
// 删除 agentProfile 前必须先完成下架（router 层校验），防止绕过缓冲期。
export const agentPublications = pgTable(
  "agentPublications",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentProfileId: text("agentProfileId")
      .notNull()
      .references(() => agentProfiles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    // 领域标签（发现/初筛用，L0 元数据）
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    // Agent Card 专长摘要（D2 喂养流水线 LLM 刷新；null = 尚未生成）
    autoExpertise: jsonb("auto_expertise").$type<string[] | null>(),
    // 卡片头像资产 id（无 FK：资产删除后头像优雅降级为默认）
    avatarAssetId: text("avatarAssetId"),
    // 单次知识检索调用单价（单位：credits；P0 仅记账不结算）
    pricePerCall: integer("pricePerCall").notNull().default(0),
    // F2 per-publication 会话计费封顶（credits）；null = 跟随全局默认
    // （serverConfig.consultation.sessionBillingCapCredits）
    billingCapPerSession: integer("billingCapPerSession"),
    status: text("status", {
      enum: ["published", "delisting", "delisted"],
    })
      .notNull()
      .default("published"),
    delistingAt: timestamp("delistingAt", { withTimezone: true }),
    delistedAt: timestamp("delistedAt", { withTimezone: true }),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (ap) => [
    index("agentPublications_userId_idx").on(ap.userId),
    index("agentPublications_status_idx").on(ap.status),
    // 同一档案同一时间至多一个发布（delisted 后可复活）
    unique().on(ap.userId, ap.agentProfileId),
  ],
);

// ── D6 咨询计量（per-call 记账；P0 只记账不结算） ──────
// 咨询会话每条成功回复记一笔，amount 是记账当时的单价快照
// （发布调价不影响已记条目），为后续支付结算留数据基础。
export const consultationUsages = pgTable(
  "consultationUsages",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    publicationId: text("publicationId")
      .notNull()
      .references(() => agentPublications.id, { onDelete: "cascade" }),
    consulteeUserId: text("consulteeUserId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("sessionId")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    // 本次调用单价快照（credits）
    amount: integer("amount").notNull(),
    // P2 技能使用统计：该轮点选的技能；技能删除后置 null（历史保留）
    skillId: text("skillId").references(() => agentSkills.id, {
      onDelete: "set null",
    }),
    // F4 结算归属；null = 未结算
    settlementId: text("settlementId").references(
      () => consultationSettlements.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAtMsField(),
  },
  (cu) => [
    index("consultationUsages_sessionId_idx").on(cu.sessionId),
    index("consultationUsages_publicationId_idx").on(cu.publicationId),
  ],
);

// ── F4 咨询结算单：把一批未结算 usage 打包成快照 ──────
// P1 无支付通道，结算 = 所有者触发的汇总快照（金额 + 笔数），
// usage 行打上 settlementId 标记已结算；P2 接入真实支付后在此扩展。
export const consultationSettlements = pgTable(
  "consultationSettlements",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    publicationId: text("publicationId")
      .notNull()
      .references(() => agentPublications.id, { onDelete: "cascade" }),
    // 结算时的所有者快照（发布转让后仍可追溯原主）
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 本单汇总（credits）
    amount: integer("amount").notNull(),
    usageCount: integer("usageCount").notNull(),
    createdAt: createdAtMsField(),
  },
  (cs) => [
    index("consultationSettlements_publicationId_idx").on(cs.publicationId),
  ],
);

// ── Credits 台账（append-only ledger）──────────────
// 所有 credits 流入流出都记一条 delta，users.creditsBalance = SUM(delta)
// 权威来源；balanceAfter 是每条记录的快照（对账用）。
export const creditTransactions = pgTable(
  "creditTransactions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 正数增加、负数减少
    delta: integer("delta").notNull(),
    // 交易类型
    type: text("type", {
      enum: [
        "subscription_grant",
        "consultation_charge",
        "consultation_payout",
        "refund",
        "admin_adjust",
      ],
    }).notNull(),
    // 可选关联实体（方便追溯）
    referenceType: text("referenceType"),
    referenceId: text("referenceId"),
    // 交易后的余额快照（用于对账；应用层写入）
    balanceAfter: integer("balanceAfter").notNull(),
    createdAt: createdAtMsField(),
  },
  (ct) => [
    index("creditTransactions_userId_idx").on(ct.userId),
    index("creditTransactions_userType_idx").on(ct.userId, ct.type),
    index("creditTransactions_reference_idx").on(
      ct.referenceType,
      ct.referenceId,
    ),
  ],
);

// ── A2A 咨询消息（agent ↔ agent 异步信箱）──────────────
//
// 跨用户/跨 Agent 的异步咨询信封：requester 向已发布的目标 Agent 发问，
// worker 通过影子会话（chatSessions）执行咨询流（知识检索按发布所有者、
// 沿用计量记账），答案回写 answer。need_input 态预留目标方反问澄清
// （EigenFlux need_input 契约模式）。
export const agentMessages = pgTable(
  "agentMessages",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    // 发起方：咨询用户（P0 人确认后代发；P2 agent 自主发起需预算授权）
    requesterUserId: text("requesterUserId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 发起方使用的个人 Agent 档案（null = 用户本人直接提问）
    requesterProfileId: text("requesterProfileId").references(
      () => agentProfiles.id,
      { onDelete: "set null" },
    ),
    // 目标：被咨询的发布（hosted / openai-compatible 型可异步执行）
    targetPublicationId: text("targetPublicationId")
      .notNull()
      .references(() => agentPublications.id, { onDelete: "cascade" }),
    // 点选的技能（可空；发布方技能）
    skillId: text("skillId").references(() => agentSkills.id, {
      onDelete: "set null",
    }),
    // 影子会话：worker 以此复用 sendMessageSync 咨询执行链
    sessionId: text("sessionId").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    // 自主发起链：父消息（专家代理自主咨询时指向触发它的那条），递归防护用
    parentMessageId: text("parentMessageId"),
    // 链深度：根消息=0，每层子咨询 +1（递归防护上限）
    depth: integer("depth").notNull().default(0),
    question: text("question").notNull(),
    answer: text("answer"),
    // pending: 待执行 / dispatched: 执行中 / answered: 已回答
    // need_input: 目标方反问待澄清 / expired: 超时 / failed: 执行失败
    state: text("state", {
      enum: [
        "pending",
        "dispatched",
        "answered",
        "need_input",
        "expired",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    // failed/need_input 时的说明
    note: text("note"),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    // 本次咨询扣减的 credits（快照；send 时写入，失败时 refund 回退余额）
    creditsCharged: integer("creditsCharged").notNull().default(0),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (am) => [
    index("agentMessages_target_state_idx").on(
      am.targetPublicationId,
      am.state,
    ),
    index("agentMessages_requester_created_idx").on(
      am.requesterUserId,
      am.createdAt,
    ),
    index("agentMessages_session_idx").on(am.sessionId),
  ],
);

export const canvases = pgTable(
  "canvases",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    title: text("title").notNull().default("未命名画布"),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<unknown>(),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (c) => [
    index("canvases_userId_idx").on(c.userId),
    index("canvases_userId_modifiedAt_idx").on(c.userId, c.modifiedAt),
  ],
);

// ── Widget 沙箱（chat 用户定制组件）──────────────────────
//
// widgets 保存组件当前状态（code 为当前版本内容），
// widgetVersions 为 append-only 版本历史（回滚 = 复制目标版本为新版本）。

export const widgets = pgTable(
  "widgets",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // WidgetManifest（@saiye/shared/types/widgets）：{ apiVersion, size, permissions }
    manifest: jsonb("manifest").$type<unknown>(),
    // HTML 片段（非完整文档），只在客户端沙箱内执行，服务端永不 eval
    code: text("code").notNull(),
    status: text("status", { enum: ["draft", "enabled"] }).notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (w) => [
    index("widgets_userId_idx").on(w.userId),
    index("widgets_userId_modifiedAt_idx").on(w.userId, w.modifiedAt),
  ],
);

export const widgetVersions = pgTable(
  "widgetVersions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    widgetId: text("widgetId")
      .notNull()
      .references(() => widgets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    code: text("code").notNull(),
    manifest: jsonb("manifest").$type<unknown>(),
    createdAt: createdAtMsField(),
  },
  (wv) => [index("widgetVersions_widgetId_idx").on(wv.widgetId, wv.version)],
);

// ── C2 分享链接（快照语义）──────────────────────────
//
// 用户把 agentProfile/widget/prompt 以快照形式分享为公开链接：
// - payload 与 C1 导出信封的 data 同构（apiKey 永不入快照）
// - 源资产后续修改/删除不影响已分享内容
// - revoke = 删除行（链接即失效）
export const sharedAgentAssets = pgTable(
  "sharedAgentAssets",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetType: text("assetType", {
      enum: ["agentProfile", "widget", "prompt"],
    }).notNull(),
    // 源资产 id（参考字段，不设 FK——源删除后分享快照仍有效）
    assetId: text("assetId").notNull(),
    shareToken: text("shareToken").notNull().unique(),
    name: text("name").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    createdAt: createdAtMsField(),
  },
  (s) => [
    index("sharedAgentAssets_userId_idx").on(s.userId),
    unique().on(s.userId, s.assetType, s.assetId),
  ],
);

export const rssFeedsTable = pgTable(
  "rssFeeds",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    url: text("url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    importTags: boolean("importTags").notNull().default(false),
    createdAt: createdAtField(),
    lastFetchedAt: timestamp("lastFetchedAt", { withTimezone: true }),
    lastSuccessfulFetchAt: timestamp("lastSuccessfulFetchAt", {
      withTimezone: true,
    }),
    lastFetchedStatus: text("lastFetchedStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bl) => [index("rssFeeds_userId_idx").on(bl.userId)],
);

export const webhooksTable = pgTable(
  "webhooks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    createdAt: createdAtField(),
    url: text("url").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    events: jsonb("events")
      .notNull()
      .$type<("created" | "edited" | "crawled" | "ai tagged" | "deleted")[]>(),
    token: text("token"),
  },
  (bl) => [index("webhooks_userId_idx").on(bl.userId)],
);

export const rssFeedImportsTable = pgTable(
  "rssFeedImports",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    createdAt: createdAtField(),
    entryId: text("entryId").notNull(),
    rssFeedId: text("rssFeedId")
      .notNull()
      .references(() => rssFeedsTable.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId").references(() => bookmarks.id, {
      onDelete: "set null",
    }),
  },
  (bl) => [
    index("rssFeedImports_feedIdIdx_idx").on(bl.rssFeedId),
    index("rssFeedImports_entryIdIdx_idx").on(bl.entryId),
    unique().on(bl.rssFeedId, bl.entryId),
    index("rssFeedImports_bookmarkId_idx").on(bl.bookmarkId),
    // Composite index for RSS feed filter queries (when filtering by rssFeedId)
    index("rssFeedImports_rssFeedId_bookmarkId_idx").on(
      bl.rssFeedId,
      bl.bookmarkId,
    ),
  ],
);

export const backupsTable = pgTable(
  "backups",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: text("assetId").references(() => assets.id, {
      onDelete: "cascade",
    }),
    createdAt: createdAtField(),
    size: integer("size").notNull(),
    bookmarkCount: integer("bookmarkCount").notNull(),
    status: text("status", {
      enum: ["pending", "success", "failure"],
    })
      .notNull()
      .default("pending"),
    errorMessage: text("errorMessage"),
  },
  (b) => [
    index("backups_userId_idx").on(b.userId),
    index("backups_createdAt_idx").on(b.createdAt),
  ],
);

export const config = pgTable("config", {
  key: text("key").notNull().primaryKey(),
  value: text("value").notNull(),
});

export const ruleEngineRulesTable = pgTable(
  "ruleEngineRules",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    enabled: boolean("enabled").notNull().default(true),
    name: text("name").notNull(),
    description: text("description"),
    event: text("event").notNull(),
    condition: text("condition").notNull(),

    // References
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tagId: text("tagId"),
  },
  (rl) => [
    index("ruleEngine_userId_idx").on(rl.userId),

    // Ensures correct ownership
    foreignKey({
      columns: [rl.userId, rl.tagId],
      foreignColumns: [bookmarkTags.userId, bookmarkTags.id],
      name: "ruleEngineRules_userId_tagId_fk",
    }).onDelete("cascade"),
  ],
);

export const ruleEngineActionsTable = pgTable(
  "ruleEngineActions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ruleId: text("ruleId")
      .notNull()
      .references(() => ruleEngineRulesTable.id, { onDelete: "cascade" }),
    action: text("action").notNull(),

    // References
    listId: text("listId"),
    tagId: text("tagId"),
  },
  (rl) => [
    index("ruleEngineActions_userId_idx").on(rl.userId),
    index("ruleEngineActions_ruleId_idx").on(rl.ruleId),
    // Ensures correct ownership
    foreignKey({
      columns: [rl.userId, rl.tagId],
      foreignColumns: [bookmarkTags.userId, bookmarkTags.id],
      name: "ruleEngineActions_userId_tagId_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [rl.userId, rl.listId],
      foreignColumns: [bookmarkLists.userId, bookmarkLists.id],
      name: "ruleEngineActions_userId_listId_fk",
    }).onDelete("cascade"),
  ],
);

export const invites = pgTable("invites", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAtField(),
  usedAt: timestamp("usedAt", { withTimezone: true }),
  invitedBy: text("invitedBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
    stripeCustomerId: text("stripeCustomerId").notNull(),
    stripeSubscriptionId: text("stripeSubscriptionId"),
    status: text("status", {
      enum: [
        "active",
        "canceled",
        "past_due",
        "unpaid",
        "incomplete",
        "trialing",
        "incomplete_expired",
        "paused",
      ],
    }).notNull(),
    tier: text("tier", {
      enum: ["free", "paid"],
    })
      .notNull()
      .default("free"),
    priceId: text("priceId"),
    cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").default(false),
    startDate: timestamp("startDate", { withTimezone: true }),
    endDate: timestamp("endDate", { withTimezone: true }),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
  },
  (s) => [
    index("subscriptions_userId_idx").on(s.userId),
    index("subscriptions_stripeCustomerId_idx").on(s.stripeCustomerId),
  ],
);

export const importSessions = pgTable(
  "importSessions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message"),
    rootListId: text("rootListId").references(() => bookmarkLists.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: [
        "staging",
        "pending",
        "running",
        "paused",
        "completed",
        "failed",
        "archived",
      ],
    })
      .notNull()
      .default("staging"),
    lastProcessedAt: timestamp("lastProcessedAt", { withTimezone: true }),
    completedAt: timestamp("completedAt", { withTimezone: true }),
    totalBookmarks: integer("totalBookmarks").notNull().default(0),
    completedBookmarks: integer("completedBookmarks").notNull().default(0),
    failedBookmarks: integer("failedBookmarks").notNull().default(0),
    pendingBookmarks: integer("pendingBookmarks").notNull().default(0),
    processingBookmarks: integer("processingBookmarks").notNull().default(0),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
  },
  (is) => [
    index("importSessions_userId_idx").on(is.userId),
    index("importSessions_status_idx").on(is.status),
    index("importSessions_status_completedAt_idx").on(
      is.status,
      is.completedAt,
    ),
  ],
);

export const importSessionBookmarks = pgTable(
  "importSessionBookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    importSessionId: text("importSessionId")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    createdAt: createdAtField(),
  },
  (isb) => [
    index("importSessionBookmarks_bookmarkId_idx").on(isb.bookmarkId),
    unique().on(isb.importSessionId, isb.bookmarkId),
  ],
);

export const importStagingBookmarks = pgTable(
  "importStagingBookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    importSessionId: text("importSessionId")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),

    // Bookmark data to create
    type: text("type", { enum: ["link", "text", "asset"] }).notNull(),
    url: text("url"),
    title: text("title"),
    content: text("content"),
    note: text("note"),
    tags: jsonb("tags").$type<string[]>(),
    listIds: jsonb("listIds").$type<string[]>(),
    sourceAddedAt: timestamp("sourceAddedAt", { withTimezone: true }),
    archived: boolean("archived"),

    // Processing state
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    processingStartedAt: timestamp("processingStartedAt", {
      withTimezone: true,
    }),

    // Result (for observability)
    result: text("result", {
      enum: ["accepted", "rejected", "skipped_duplicate"],
    }),
    resultReason: text("resultReason"),
    resultBookmarkId: text("resultBookmarkId").references(() => bookmarks.id, {
      onDelete: "set null",
    }),

    createdAt: createdAtField(),
    completedAt: timestamp("completedAt", { withTimezone: true }),
  },
  (isb) => [
    index("importStaging_session_status_idx").on(
      isb.importSessionId,
      isb.status,
    ),
    index("importStaging_completedAt_idx").on(isb.completedAt),
    index("importStaging_resultBookmarkId_idx").on(isb.resultBookmarkId),
    index("importStaging_status_idx").on(isb.status),
    index("importStaging_status_processingStartedAt_idx").on(
      isb.status,
      isb.processingStartedAt,
    ),
  ],
);

// Relations

export const userRelations = relations(users, ({ many, one }) => ({
  tags: many(bookmarkTags),
  bookmarks: many(bookmarks),
  webhooks: many(webhooksTable),
  rules: many(ruleEngineRulesTable),
  chatSessions: many(chatSessions),
  agentProfiles: many(agentProfiles),
  canvases: many(canvases),
  invites: many(invites),
  subscription: one(subscriptions),
  importSessions: many(importSessions),
  listCollaborations: many(listCollaborators),
  backups: many(backupsTable),
  listInvitations: many(listInvitations),
}));

export const bookmarkRelations = relations(bookmarks, ({ many, one }) => ({
  user: one(users, {
    fields: [bookmarks.userId],
    references: [users.id],
  }),
  link: one(bookmarkLinks, {
    fields: [bookmarks.id],
    references: [bookmarkLinks.id],
  }),
  text: one(bookmarkTexts, {
    fields: [bookmarks.id],
    references: [bookmarkTexts.id],
  }),
  asset: one(bookmarkAssets, {
    fields: [bookmarks.id],
    references: [bookmarkAssets.id],
  }),
  tagsOnBookmarks: many(tagsOnBookmarks),
  bookmarksInLists: many(bookmarksInLists),
  assets: many(assets),
  rssFeeds: many(rssFeedImportsTable),
  importSessionBookmarks: many(importSessionBookmarks),
}));

export const assetRelations = relations(assets, ({ one }) => ({
  bookmark: one(bookmarks, {
    fields: [assets.bookmarkId],
    references: [bookmarks.id],
  }),
}));

export const bookmarkTagsRelations = relations(
  bookmarkTags,
  ({ many, one }) => ({
    user: one(users, {
      fields: [bookmarkTags.userId],
      references: [users.id],
    }),
    tagsOnBookmarks: many(tagsOnBookmarks),
  }),
);

export const tagsOnBookmarksRelations = relations(
  tagsOnBookmarks,
  ({ one }) => ({
    tag: one(bookmarkTags, {
      fields: [tagsOnBookmarks.tagId],
      references: [bookmarkTags.id],
    }),
    bookmark: one(bookmarks, {
      fields: [tagsOnBookmarks.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const conceptPageRelations = relations(
  conceptPages,
  ({ one, many }) => ({
    user: one(users, {
      fields: [conceptPages.userId],
      references: [users.id],
    }),
    sources: many(conceptPageSources),
  }),
);

export const conceptPageSourceRelations = relations(
  conceptPageSources,
  ({ one }) => ({
    page: one(conceptPages, {
      fields: [conceptPageSources.pageId],
      references: [conceptPages.id],
    }),
    bookmark: one(bookmarks, {
      fields: [conceptPageSources.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const bookmarkListsRelations = relations(
  bookmarkLists,
  ({ one, many }) => ({
    bookmarksInLists: many(bookmarksInLists),
    collaborators: many(listCollaborators),
    invitations: many(listInvitations),
    user: one(users, {
      fields: [bookmarkLists.userId],
      references: [users.id],
    }),
    parent: one(bookmarkLists, {
      fields: [bookmarkLists.parentId],
      references: [bookmarkLists.id],
    }),
  }),
);

export const bookmarksInListsRelations = relations(
  bookmarksInLists,
  ({ one }) => ({
    bookmark: one(bookmarks, {
      fields: [bookmarksInLists.bookmarkId],
      references: [bookmarks.id],
    }),
    list: one(bookmarkLists, {
      fields: [bookmarksInLists.listId],
      references: [bookmarkLists.id],
    }),
  }),
);

export const listCollaboratorsRelations = relations(
  listCollaborators,
  ({ one }) => ({
    list: one(bookmarkLists, {
      fields: [listCollaborators.listId],
      references: [bookmarkLists.id],
    }),
    user: one(users, {
      fields: [listCollaborators.userId],
      references: [users.id],
    }),
    addedByUser: one(users, {
      fields: [listCollaborators.addedBy],
      references: [users.id],
    }),
  }),
);

export const listInvitationsRelations = relations(
  listInvitations,
  ({ one }) => ({
    list: one(bookmarkLists, {
      fields: [listInvitations.listId],
      references: [bookmarkLists.id],
    }),
    user: one(users, {
      fields: [listInvitations.userId],
      references: [users.id],
    }),
    invitedByUser: one(users, {
      fields: [listInvitations.invitedBy],
      references: [users.id],
    }),
  }),
);

export const webhooksRelations = relations(webhooksTable, ({ one }) => ({
  user: one(users, {
    fields: [webhooksTable.userId],
    references: [users.id],
  }),
}));

export const ruleEngineRulesRelations = relations(
  ruleEngineRulesTable,
  ({ one, many }) => ({
    user: one(users, {
      fields: [ruleEngineRulesTable.userId],
      references: [users.id],
    }),
    actions: many(ruleEngineActionsTable),
  }),
);

export const ruleEngineActionsTableRelations = relations(
  ruleEngineActionsTable,
  ({ one }) => ({
    rule: one(ruleEngineRulesTable, {
      fields: [ruleEngineActionsTable.ruleId],
      references: [ruleEngineRulesTable.id],
    }),
  }),
);

export const rssFeedImportsTableRelations = relations(
  rssFeedImportsTable,
  ({ one }) => ({
    rssFeed: one(rssFeedsTable, {
      fields: [rssFeedImportsTable.rssFeedId],
      references: [rssFeedsTable.id],
    }),
    bookmark: one(bookmarks, {
      fields: [rssFeedImportsTable.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const invitesRelations = relations(invites, ({ one }) => ({
  invitedBy: one(users, {
    fields: [invites.invitedBy],
    references: [users.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

export const passwordResetTokensRelations = relations(
  passwordResetTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [passwordResetTokens.userId],
      references: [users.id],
    }),
  }),
);

export const chatSessionsRelations = relations(
  chatSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [chatSessions.userId],
      references: [users.id],
    }),
    messages: many(chatMessages),
    agentProfile: one(agentProfiles, {
      fields: [chatSessions.agentProfileId],
      references: [agentProfiles.id],
    }),
  }),
);

export const agentProfilesRelations = relations(
  agentProfiles,
  ({ one, many }) => ({
    user: one(users, {
      fields: [agentProfiles.userId],
      references: [users.id],
    }),
    chatSessions: many(chatSessions),
  }),
);

export const agentMemoriesRelations = relations(agentMemories, ({ one }) => ({
  user: one(users, {
    fields: [agentMemories.userId],
    references: [users.id],
  }),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  chat: one(chatSessions, {
    fields: [chatMessages.chatId],
    references: [chatSessions.id],
  }),
}));

export const agentPublicationsRelations = relations(
  agentPublications,
  ({ one }) => ({
    user: one(users, {
      fields: [agentPublications.userId],
      references: [users.id],
    }),
    agentProfile: one(agentProfiles, {
      fields: [agentPublications.agentProfileId],
      references: [agentProfiles.id],
    }),
  }),
);

export const importSessionsRelations = relations(
  importSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [importSessions.userId],
      references: [users.id],
    }),
    bookmarks: many(importSessionBookmarks),
  }),
);

export const importSessionBookmarksRelations = relations(
  importSessionBookmarks,
  ({ one }) => ({
    importSession: one(importSessions, {
      fields: [importSessionBookmarks.importSessionId],
      references: [importSessions.id],
    }),
    bookmark: one(bookmarks, {
      fields: [importSessionBookmarks.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const backupsRelations = relations(backupsTable, ({ one }) => ({
  user: one(users, {
    fields: [backupsTable.userId],
    references: [users.id],
  }),
  asset: one(assets, {
    fields: [backupsTable.assetId],
    references: [assets.id],
  }),
}));

export const userReadingProgressRelations = relations(
  userReadingProgress,
  ({ one }) => ({
    bookmark: one(bookmarks, {
      fields: [userReadingProgress.bookmarkId],
      references: [bookmarks.id],
    }),
    user: one(users, {
      fields: [userReadingProgress.userId],
      references: [users.id],
    }),
  }),
);
