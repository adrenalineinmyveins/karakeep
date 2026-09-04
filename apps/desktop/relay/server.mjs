#!/usr/bin/env node
/**
 * 微信扫码登录公网中转服务（桌面版/内网部署用）。
 *
 * 背景：微信开放平台的「授权回调域」不允许 localhost / 127.0.0.1 / 内网 IP，
 * 桌面版（本机 web 服务）无法直接接收扫码回调。本服务部署在已备案的公网域名上，
 * 收到微信回调后仅做 302 透传：把 code / state 重定向回发起扫码的本机 NextAuth
 * 回调（cb 参数指定回跳地址）。
 *
 * 安全性：本服务不持有任何密钥（AppSecret 只在本机，code 换 token 在本机完成）；
 * state 仍由本机 NextAuth cookie 校验，中转只透传；cb 仅允许回环地址，
 * 防止被当作开放重定向滥用。
 *
 * 用法：
 *   node server.mjs            # PORT 环境变量可改监听端口，默认 8080
 *   pm2 start server.mjs --name wechat-relay
 *
 * 微信开放平台配置（「网站应用」→ 授权回调域）：填本服务域名（不含协议与路径）。
 *
 * 客户端配置（桌面版写入 config.json 的 userEnv，或自托管 web 的 env）：
 *   WECHAT_APP_ID=...
 *   WECHAT_APP_SECRET=...
 *   WECHAT_REDIRECT_URI=https://<本服务域名>/wechat/callback?cb=http%3A%2F%2F127.0.0.1%3A3000
 *   （cb 端口 = 桌面 web 实际端口；部署到公网的 web 版无需 WECHAT_REDIRECT_URI）
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
// cb 白名单：仅允许重定向回本机回环地址
const CB_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/wechat/callback") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const cb = url.searchParams.get("cb") ?? "http://127.0.0.1:3000";
    if (!CB_PATTERN.test(cb)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("cb must be a loopback address (127.0.0.1 / localhost)");
      return;
    }
    const target = new URL("/api/auth/callback/wechat", cb);
    for (const key of ["code", "state"]) {
      const value = url.searchParams.get(key);
      if (value) {
        target.searchParams.set(key, value);
      }
    }
    res.writeHead(302, { location: target.toString() });
    res.end();
  })
  .listen(PORT, () => {
    console.log(`[wechat-relay] listening on :${PORT}`);
  });
