/**
 * Widget 生成规范 —— 供 Agent 工具描述使用（save_widget / update_widget）。
 *
 * 与运行时契约保持同步：
 * - 沙箱包装：apps/web/lib/widgets/runtime.ts（CSP / 主题变量 / saiye SDK）
 * - postMessage 桥：apps/web/components/dashboard/widgets/WidgetHost.tsx
 * - manifest / lint：@saiye/shared/types/widgets.ts
 */
export const WIDGET_SPEC = `## Widget 组件规范

你正在为用户的界面生成一个沙箱小组件（HTML 片段）。它会在 <iframe sandbox="allow-scripts"> 中执行。

### 代码契约（必须遵守，违反会被拒绝）
1. 只输出 HTML 片段（不是完整文档）：允许 <style>、内联 <script>，渲染目标为 <div id="root"></div>。
2. 禁止外部资源：<script src>、<link href>、远程图片；禁止网络 API（fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon / 动态 import）。
3. 样式使用注入的 CSS 变量适配明暗主题：
   --background（背景） --foreground（文字） --muted / --muted-foreground（次要文字）
   --card（卡片背景） --border（边框） --primary / --primary-foreground（强调） --radius（圆角）
4. 高度自适应由宿主完成（ResizeObserver 自动上报），不要写固定外层高度。
5. 保持组件小型（建议 < 200 行），避免复杂依赖与深嵌套 DOM。

### 数据获取（唯一通道：window.saiye SDK，全部返回 Promise）
- saiye.bookmarks.search({ text, limit? }) → 按关键词搜索书签，返回 { bookmarks: [...], nextCursor }
- saiye.bookmarks.recent({ limit?, archived?, favourited?, tagId?, listId? }) → 最近书签（默认倒序），返回 { bookmarks: [...], nextCursor }
- saiye.bookmarks.get({ bookmarkId }) → 书签详情
- saiye.tags.list({ nameContains?, sortBy?, limit? }) → { tags: [...] }
- saiye.lists.list() → { lists: [...] }
书签对象常用字段：id、title、summary、createdAt（毫秒时间戳）、content.type（"link"|"text"）、content.url、content.description、tags。
注意：必须声明 permissions 才能调用对应 API（见下），调用未授权的 API 会收到 permission denied 错误。

### 写操作（v1，需声明对应写权限；预览模式下被拦截，安装后才真实生效）
- saiye.bookmarks.create({ type: "link"|"text", url?, text?, title?, note?, summary? }) → 新建书签，返回书签对象
- saiye.bookmarks.update({ bookmarkId, title?, note?, summary?, favourited?, archived? }) → 修改书签（归档传 archived: true，取消收藏传 favourited: false）
- saiye.bookmarks.setTags({ bookmarkId, attach: [{ tagName: "xx" }|{ tagId: "xx" }], detach: [...] }) → 给书签加/摘标签（可按名或按 ID，最多各 50 个）
- saiye.bookmarks.delete({ bookmarkId }) → 删除书签（宿主会向用户弹确认，拒绝时收到 user_denied 错误）
- saiye.tags.create({ name }) → 新建标签；saiye.tags.delete({ tagId }) → 删除标签（需用户确认）
- saiye.lists.create({ name, description? }) → 新建清单；saiye.lists.delete({ listId }) → 删除清单（需用户确认）
- saiye.lists.addToList({ listId, bookmarkId }) / saiye.lists.removeFromList({ listId, bookmarkId }) → 清单成员增删
写权限："bookmarks:write"（bookmarks.create/update/setTags）、"tags:write"（tags.create）、"lists:write"（lists.create/addToList/removeFromList）、删除类 "bookmarks:delete" / "tags:delete" / "lists:delete"。声明了写权限的组件，安装时用户会看到明确的授权提示。

### manifest 参数（与代码一起提供）
- size: "sm" | "md" | "lg" —— 组件在网格中的占位（sm 小卡 / md 标准 / lg 大卡，图表类建议 lg）
- permissions: 需要的能力数组，按实际用到的 API 声明，不要多要：
  "bookmarks:read"（读书签）、"tags:read"（读标签）、"lists:read"（读清单）、
  "bookmarks:write"（建/改书签、打标签）、"tags:write"（建标签）、"lists:write"（建清单、清单成员增删）、
  "bookmarks:delete" / "tags:delete" / "lists:delete"（删除，用户安装时需单独确认）

### 参考示例（本周书签统计卡）
<div id="root"></div>
<style>
  #root { font: 14px/1.5 system-ui; color: var(--foreground); }
  .num { font-size: 32px; font-weight: 700; }
  .label { color: var(--muted-foreground); font-size: 12px; }
</style>
<script>
  (function () {
    var weekAgo = Date.now() - 7 * 86400000;
    saiye.bookmarks.recent({ limit: 100 }).then(function (res) {
      var n = res.bookmarks.filter(function (b) {
        return new Date(b.createdAt).getTime() >= weekAgo;
      }).length;
      document.getElementById('root').innerHTML =
        '<div class="num">' + n + '</div><div class="label">本周保存的书签</div>';
    });
  })();
</script>
manifest: { size: "md", permissions: ["bookmarks:read"] }

### 交互守则
- 新建组件用 save_widget；修改已有组件用 update_widget（widgetId 必须来自本对话的工具结果或 list_widgets 查询，不要凭记忆编造）。
- 生成后告知用户：组件出现在预览卡中，点"安装"后才会显示在"小组件"页面。
- 用户对效果不满意时，继续用 update_widget 迭代；用户想撤销改动时用 rollback_widget。
- 所有写调用必须 .catch 并降级处理，不要让异常中断渲染：
  预览态收到 preview_write_blocked 时显示"安装后可用"提示（按钮置灰即可）；
  收到 user_denied 时安静处理（用户就是拒绝了）。
- 删除类操作必须由用户显式点击触发（宿主会逐次弹确认），禁止组件加载即删、定时删、循环自动删。
- 批量操作（如给多个书签打标签）逐条调用并汇报进度，没有批量 API。`;
