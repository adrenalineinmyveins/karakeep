/**
 * Widget 沙箱运行时：拼装沙箱 HTML 文档 + 注入 saiye SDK。
 *
 * 安全模型：
 * - <iframe sandbox="allow-scripts">（无 allow-same-origin）→ opaque origin，
 *   无法访问父页 DOM/cookie/localStorage。
 * - meta CSP default-src 'none' 封死一切网络外联（即使 lint 被绕过也无法外泄/下载远程脚本）。
 * - widget 与宿主的唯一通信通道是 postMessage（见 WidgetHost.tsx）。
 */

const BOOTSTRAP_SCRIPT = `
(function () {
  var callbacks = {};
  var nextId = 1;
  var saiye = { env: __SAIYE_ENV__ };

  // SDK：把方法调用封装为 Promise，通过 postMessage 发往宿主，等待回执
  // 写方法超时 60s：L2 删除需等宿主确认对话框用户点击；读默认 30s（dev 冷启动按需编译可超 10s）
  var WRITE_TIMEOUT = 60000;
  function call(method, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var timer = setTimeout(function () {
        delete callbacks[id];
        reject(new Error('saiye.' + method + ' timed out'));
      }, timeoutMs || 30000);
      callbacks[id] = { resolve: resolve, reject: reject, timer: timer };
      parent.postMessage({ saiye: true, id: id, type: 'api', method: method, payload: payload }, '*');
    });
  }

  // 宿主回执：匹配挂起调用并 settle（缺了这步所有调用都会等到超时）
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.saiye !== true || d.id == null) return;
    var cb = callbacks[d.id];
    if (!cb) return;
    delete callbacks[d.id];
    clearTimeout(cb.timer);
    if (d.ok) {
      cb.resolve(d.data);
    } else {
      cb.reject(new Error(d.error || 'unknown error'));
    }
  });

  saiye.bookmarks = {
    search: function (p) { return call('bookmarks.search', p || {}); },
    recent: function (p) { return call('bookmarks.recent', p || {}); },
    get: function (p) { return call('bookmarks.get', p || {}); },
    create: function (p) { return call('bookmarks.create', p || {}, WRITE_TIMEOUT); },
    update: function (p) { return call('bookmarks.update', p || {}, WRITE_TIMEOUT); },
    setTags: function (p) { return call('bookmarks.setTags', p || {}, WRITE_TIMEOUT); },
    delete: function (p) { return call('bookmarks.delete', p || {}, WRITE_TIMEOUT); }
  };
  saiye.tags = {
    list: function (p) { return call('tags.list', p || {}); },
    create: function (p) { return call('tags.create', p || {}, WRITE_TIMEOUT); },
    delete: function (p) { return call('tags.delete', p || {}, WRITE_TIMEOUT); }
  };
  saiye.lists = {
    list: function (p) { return call('lists.list', p || {}); },
    create: function (p) { return call('lists.create', p || {}, WRITE_TIMEOUT); },
    addToList: function (p) { return call('lists.addToList', p || {}, WRITE_TIMEOUT); },
    removeFromList: function (p) { return call('lists.removeFromList', p || {}, WRITE_TIMEOUT); },
    delete: function (p) { return call('lists.delete', p || {}, WRITE_TIMEOUT); }
  };

  window.saiye = saiye;

  // 错误占位：widget 代码崩溃（同步 throw / Promise 未捕获拒绝）时显示占位而非空白。
  // 只处理脚本错误（ErrorEvent），忽略资源加载失败（img 等，event 无 message）。
  var errored = false;
  function showError(msg) {
    if (errored) return;
    errored = true;
    var box = document.createElement('div');
    box.setAttribute('style', 'margin:8px;padding:12px;border:1px dashed var(--border);border-radius:8px;color:var(--muted-foreground);font-size:12px;word-break:break-all;');
    box.textContent = '组件运行出错：' + msg;
    var root = document.getElementById('root');
    if (root) { root.replaceChildren(box); } else { document.body.replaceChildren(box); }
    // 上报宿主：主框架 console 留痕，便于用户报障时排查
    parent.postMessage({ saiye: true, type: 'error', payload: { message: String(msg) } }, '*');
  }
  window.addEventListener('error', function (e) {
    if (e && e.message) showError(e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    showError(r && r.message ? r.message : String(r));
  });

  // 高度自适应：监听 body 尺寸变化，上报给宿主
  function reportHeight() {
    var h = document.documentElement.scrollHeight;
    parent.postMessage({ saiye: true, type: 'resize', payload: { height: h } }, '*');
  }
  var ro = new ResizeObserver(reportHeight);
  ro.observe(document.documentElement);
  // 首帧 + 资源加载后各报一次
  reportHeight();
  window.addEventListener('load', reportHeight);
})();
`;

function escapeEnv(theme: "dark" | "light") {
  return JSON.stringify({ apiVersion: 1, theme });
}

/**
 * 拼装沙箱完整 HTML 文档（iframe srcdoc 用）。
 * @param code 用户的 HTML 片段（<style>/<script>/#root）
 * @param theme 当前主题，用于注入 CSS 变量
 */
export function buildSandboxDoc(code: string, theme: "dark" | "light"): string {
  const env = escapeEnv(theme);
  return `<!DOCTYPE html>
<html class="${theme === "dark" ? "dark" : ""}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">
<style>
html, body { margin: 0; padding: 0; background: transparent; color: var(--foreground, #000); font-family: system-ui, -apple-system, sans-serif; }
#root { box-sizing: border-box; }
:root {
  --background: ${theme === "dark" ? "#0a0a0a" : "#ffffff"};
  --foreground: ${theme === "dark" ? "#fafafa" : "#0a0a0a"};
  --muted: ${theme === "dark" ? "#737373" : "#737373"};
  --muted-foreground: ${theme === "dark" ? "#a3a3a3" : "#525252"};
  --card: ${theme === "dark" ? "#171717" : "#ffffff"};
  --card-foreground: ${theme === "dark" ? "#fafafa" : "#0a0a0a"};
  --border: ${theme === "dark" ? "#262626" : "#e5e5e5"};
  --primary: ${theme === "dark" ? "#fafafa" : "#0a0a0a"};
  --primary-foreground: ${theme === "dark" ? "#0a0a0a" : "#fafafa"};
  --radius: 0.5rem;
}
</style>
</head>
<body>
<div id="root"></div>
<script>${BOOTSTRAP_SCRIPT.replace("__SAIYE_ENV__", env)}</script>
${code}
</body>
</html>`;
}
