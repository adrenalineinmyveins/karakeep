import { z } from "zod";

/**
 * Widget（chat 用户定制组件）的类型与静态检查。
 *
 * widget code 是 HTML 片段，只在客户端 <iframe sandbox="allow-scripts"> 内执行，
 * 服务端永不 eval。lint 只是第一层体验优化（错误尽早反馈给模型自愈），
 * 真正的安全边界是沙箱 + CSP（见 docs/WIDGET_SANDBOX_DESIGN.md §8）。
 */

/** 宿主 API 版本（对外契约，破坏性变更必须升版本号） */
export const WIDGET_API_VERSION = 1;

/**
 * 权限按敏感度分三级（见 docs/WIDGET_WRITE_API_DESIGN.md §2-3）：
 * - L0 读 :read —— 只读查询
 * - L1 写 :write —— 新增数据 / 可恢复变更
 * - L2 删 :delete —— 不可逆删除
 */
export const zWidgetPermissionSchema = z.enum([
  "bookmarks:read",
  "tags:read",
  "lists:read",
  "bookmarks:write",
  "tags:write",
  "lists:write",
  "bookmarks:delete",
  "tags:delete",
  "lists:delete",
]);

export type ZWidgetPermissionTier = "read" | "write" | "delete";

/** 权限 → 敏感度级别（安装同意对话框按级别分组渲染） */
export function widgetPermissionTier(
  permission: ZWidgetPermission,
): ZWidgetPermissionTier {
  if (permission.endsWith(":read")) return "read";
  if (permission.endsWith(":write")) return "write";
  return "delete";
}

export const zWidgetManifestSchema = z.object({
  apiVersion: z.literal(WIDGET_API_VERSION),
  size: z.enum(["sm", "md", "lg"]).default("md"),
  permissions: z.array(zWidgetPermissionSchema).default([]),
});

export type ZWidgetManifest = z.infer<typeof zWidgetManifestSchema>;
export type ZWidgetPermission = z.infer<typeof zWidgetPermissionSchema>;

export const zWidgetStatusSchema = z.enum(["draft", "enabled"]);

/**
 * v1 写 API 桥侧输入窄化（D16，见 docs/WIDGET_WRITE_API_DESIGN.md §4）：
 * 组件可写的字段独立于底层 tRPC schema 收窄（strict 拒绝白名单外字段），
 * 底层 schema 日后放宽不会自动放大组件权限。
 */
const zWidgetTagRefSchema = z.strictObject({
  tagId: z.string().optional(),
  tagName: z.string().optional(),
});

export const zWidgetBookmarkCreateSchema = z.strictObject({
  type: z.enum(["link", "text"]),
  url: z.string().optional(),
  text: z.string().optional(),
  title: z.string().nullish(),
  note: z.string().optional(),
  summary: z.string().optional(),
  favourited: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const zWidgetBookmarkUpdateSchema = z.strictObject({
  bookmarkId: z.string(),
  title: z.string().nullish(),
  note: z.string().optional(),
  summary: z.string().nullish(),
  favourited: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const zWidgetBookmarkDeleteSchema = z.strictObject({
  bookmarkId: z.string(),
});

export const zWidgetSetTagsSchema = z.strictObject({
  bookmarkId: z.string(),
  attach: z.array(zWidgetTagRefSchema).max(50),
  detach: z.array(zWidgetTagRefSchema).max(50),
});

export const zWidgetTagCreateSchema = z.strictObject({ name: z.string() });
export const zWidgetTagDeleteSchema = z.strictObject({ tagId: z.string() });
export const zWidgetListCreateSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
});
export const zWidgetListMembershipSchema = z.strictObject({
  listId: z.string(),
  bookmarkId: z.string(),
});
export const zWidgetListDeleteSchema = z.strictObject({ listId: z.string() });

/** lint 黑名单：外链资源与网络 API（best-effort，绕过时由沙箱+CSP 兜底） */
const FORBIDDEN_CODE_PATTERNS: RegExp[] = [
  /<script[^>]+src=/i,
  /<link[^>]+href=/i,
  /<iframe/i,
  /<img[^>]+src=["']https?:/i,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /EventSource/,
  /navigator\.sendBeacon/,
  /\bimport\s*\(/,
];

export const MAX_WIDGET_CODE_LENGTH = 64 * 1024;

/**
 * 静态检查 widget 片段，返回全部命中的违规描述（空数组 = 通过）。
 */
export function lintWidgetCode(code: string): string[] {
  const violations: string[] = [];
  if (code.length > MAX_WIDGET_CODE_LENGTH) {
    violations.push(
      `代码超过长度上限 ${MAX_WIDGET_CODE_LENGTH} 字符，请精简组件`,
    );
  }
  for (const pattern of FORBIDDEN_CODE_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(`禁止使用外部资源或网络请求：命中规则 ${pattern}`);
    }
  }
  return violations;
}
