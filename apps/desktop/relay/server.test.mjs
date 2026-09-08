import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createRelayServer } from "./server.mjs";

/** 在随机端口启动中转服务，返回基础地址；测试结束后自动关闭 */
async function startServer(t) {
  const server = createRelayServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${port}`;
}

/** 发起 GET 请求，返回 { status, location }（不跟随重定向） */
function get(base, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, (res) => {
      res.resume(); // 丢弃响应体
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    req.on("error", reject);
  });
}

test("正常透传：302 到 cb 的 NextAuth 回调，code/state 原样携带", async (t) => {
  const base = await startServer(t);
  const res = await get(
    base,
    "/wechat/callback?code=CODE123&state=STATE456&cb=http%3A%2F%2F127.0.0.1%3A3000",
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.location,
    "http://127.0.0.1:3000/api/auth/callback/wechat?code=CODE123&state=STATE456",
  );
});

test("缺省 cb：默认回跳 127.0.0.1:3000", async (t) => {
  const base = await startServer(t);
  const res = await get(base, "/wechat/callback?code=c&state=s");
  assert.equal(res.status, 302);
  assert.equal(
    res.location,
    "http://127.0.0.1:3000/api/auth/callback/wechat?code=c&state=s",
  );
});

test("cb 为 localhost 带自定义端口：允许", async (t) => {
  const base = await startServer(t);
  const res = await get(
    base,
    "/wechat/callback?code=c&state=s&cb=http%3A%2F%2Flocalhost%3A18000",
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.location,
    "http://localhost:18000/api/auth/callback/wechat?code=c&state=s",
  );
});

test("cb 为 https 回环地址：允许", async (t) => {
  const base = await startServer(t);
  const res = await get(
    base,
    "/wechat/callback?code=c&cb=https%3A%2F%2F127.0.0.1%3A8443",
  );
  assert.equal(res.status, 302);
  assert.equal(
    res.location,
    "https://127.0.0.1:8443/api/auth/callback/wechat?code=c",
  );
});

test("cb 非回环域名（开放重定向攻击）：拒绝 400", async (t) => {
  const base = await startServer(t);
  const res = await get(
    base,
    "/wechat/callback?code=c&state=s&cb=https%3A%2F%2Fevil.com",
  );
  assert.equal(res.status, 400);
});

test("cb 回环但带路径：拒绝 400", async (t) => {
  const base = await startServer(t);
  const res = await get(
    base,
    "/wechat/callback?code=c&cb=http%3A%2F%2F127.0.0.1%3A3000%2Fphishing",
  );
  assert.equal(res.status, 400);
});

test("cb 不带协议：拒绝 400", async (t) => {
  const base = await startServer(t);
  const res = await get(
    base,
    "/wechat/callback?code=c&cb=127.0.0.1%3A3000",
  );
  assert.equal(res.status, 400);
});

test("非 /wechat/callback 路径：404", async (t) => {
  const base = await startServer(t);
  const res = await get(base, "/other/path?code=c");
  assert.equal(res.status, 404);
});

test("只传 code 不传 state：Location 只含 code", async (t) => {
  const base = await startServer(t);
  const res = await get(base, "/wechat/callback?code=ONLY_CODE");
  assert.equal(res.status, 302);
  assert.equal(
    res.location,
    "http://127.0.0.1:3000/api/auth/callback/wechat?code=ONLY_CODE",
  );
});

test("code 含特殊字符（空格/&/=）：正确编码不破坏 query 结构", async (t) => {
  const base = await startServer(t);
  const res = await get(
    base,
    "/wechat/callback?code=a+b%26c%3Dd&state=s&cb=http%3A%2F%2F127.0.0.1%3A3000",
  );
  assert.equal(res.status, 302);
  // 解码语义下 round-trip 保持原值
  const target = new URL(res.location);
  assert.equal(target.searchParams.get("code"), "a b&c=d");
  assert.equal(target.searchParams.get("state"), "s");
});
