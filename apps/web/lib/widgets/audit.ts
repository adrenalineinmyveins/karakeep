/**
 * Widget 活动日志（docs/WIDGET_WRITE_API_DESIGN.md §7.2，D2）：
 * 桥复用用户身份调用 tRPC，服务端无法把写操作归属到具体组件，
 * 因此审计只能在桥侧做；localStorage 每设备独立（已接受的设计取舍）。
 * 容量上限 100 条（环形截断），写失败（配额满/隐私模式）静默降级。
 */

export type WidgetActivityOutcome = "ok" | "error" | "denied";

export interface WidgetActivity {
  id: string;
  /** 毫秒时间戳 */
  ts: number;
  widgetId: string;
  widgetName: string;
  /** 写方法名（bookmarks.create 等）或生命周期动作（widget.install 等） */
  action: string;
  outcome: WidgetActivityOutcome;
  /** 人类可读摘要，如「新建书签《xx》」「用户拒绝」 */
  summary: string;
}

export const STORAGE_KEY = "saiye_widget_activity";
export const MAX_ENTRIES = 100;

export function getWidgetActivity(): WidgetActivity[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WidgetActivity[]) : [];
  } catch {
    return [];
  }
}

export function addWidgetActivity(
  entry: Omit<WidgetActivity, "id" | "ts">,
): void {
  if (typeof window === "undefined") return;
  try {
    const list = getWidgetActivity();
    list.unshift({
      ...entry,
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ts: Date.now(),
    });
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(list.slice(0, MAX_ENTRIES)),
    );
  } catch {
    // localStorage 不可用（隐私模式/配额满）：审计尽力而为，不影响功能
  }
}

export function clearWidgetActivity(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上，静默
  }
}

/* —— 摘要生成（best-effort，字段缺失时回退 ID 前 8 位）—— */

type Loose = Record<string, unknown> | undefined | null;

function shortId(id: unknown): string {
  return typeof id === "string" && id.length > 0
    ? `#${id.slice(0, 8)}`
    : "#unknown";
}

function nameOf(x: Loose): string {
  const name = x?.name;
  return typeof name === "string" && name.length > 0 ? name : "?";
}

/**
 * 由方法名 + 窄化后的输入 + 服务端结果生成审计摘要。
 */
export function summarizeWidgetWrite(
  method: string,
  input: Loose,
  result: Loose,
): string {
  switch (method) {
    case "bookmarks.create": {
      const title =
        typeof result?.title === "string" && result.title.length > 0
          ? `《${result.title}》`
          : shortId(result?.id);
      return `新建书签 ${title}`;
    }
    case "bookmarks.update":
      return `更新书签 ${shortId(input?.bookmarkId)}`;
    case "bookmarks.setTags": {
      const attach = Array.isArray(input?.attach) ? input.attach.length : 0;
      const detach = Array.isArray(input?.detach) ? input.detach.length : 0;
      return `为书签 ${shortId(input?.bookmarkId)} 打标签（+${attach} / -${detach}）`;
    }
    case "bookmarks.delete":
      return `删除书签 ${shortId(input?.bookmarkId)}`;
    case "tags.create":
      return `新建标签「${nameOf(input)}」`;
    case "tags.delete":
      return `删除标签 ${shortId(input?.tagId)}`;
    case "lists.create":
      return `新建清单「${nameOf(input)}」`;
    case "lists.addToList":
      return `把书签 ${shortId(input?.bookmarkId)} 加入清单 ${shortId(input?.listId)}`;
    case "lists.removeFromList":
      return `把书签 ${shortId(input?.bookmarkId)} 移出清单 ${shortId(input?.listId)}`;
    case "lists.delete":
      return `删除清单 ${shortId(input?.listId)}`;
    default:
      return method;
  }
}
