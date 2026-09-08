import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWeChatAccessToken,
  fetchWeChatUserInfo,
  WECHAT_EMAIL_DOMAIN,
  wechatEmailFromOpenid,
} from "./wechat";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 取 mock fetch 收到的请求 URL（第一个参数） */
function requestedUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
  const [input] = fetchMock.mock.calls[0] as [URL, RequestInit];
  return new URL(String(input));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWeChatAccessToken", () => {
  it("成功：GET + query 参数换 token，映射字段并透传 expires_in", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: "ACCESS_TOKEN",
        expires_in: 7200,
        refresh_token: "REFRESH_TOKEN",
        openid: "oOPENID",
        scope: "snsapi_login",
        unionid: "oUNIONID",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await fetchWeChatAccessToken({
      appId: "wxAPPID",
      appSecret: "SECRET",
      code: "CODE",
    });

    expect(tokens).toEqual({
      access_token: "ACCESS_TOKEN",
      token_type: "Bearer",
      expires_in: 7200,
      openid: "oOPENID",
    });

    // 微信协议怪癖：token 端点是 GET + query 参数
    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/sns/oauth2/access_token");
    expect(url.searchParams.get("appid")).toBe("wxAPPID");
    expect(url.searchParams.get("secret")).toBe("SECRET");
    expect(url.searchParams.get("code")).toBe("CODE");
    expect(url.searchParams.get("grant_type")).toBe("authorization_code");
  });

  it("微信业务错误（HTTP 200 + errcode 40029 invalid code）：抛错并带 errcode/errmsg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ errcode: 40029, errmsg: "invalid code" }),
      ),
    );

    await expect(
      fetchWeChatAccessToken({
        appId: "wxAPPID",
        appSecret: "SECRET",
        code: "BAD_CODE",
      }),
    ).rejects.toThrow(/40029.*invalid code/);
  });

  it("HTTP 非 2xx 且无 errcode：抛错并带状态码", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 502)),
    );

    await expect(
      fetchWeChatAccessToken({
        appId: "wxAPPID",
        appSecret: "SECRET",
        code: "CODE",
      }),
    ).rejects.toThrow(/token exchange failed: 502/);
  });

  it("响应缺 openid：抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ access_token: "ACCESS_TOKEN", expires_in: 7200 }),
      ),
    );

    await expect(
      fetchWeChatAccessToken({
        appId: "wxAPPID",
        appSecret: "SECRET",
        code: "CODE",
      }),
    ).rejects.toThrow(/token exchange failed/);
  });
});

describe("fetchWeChatUserInfo", () => {
  it("成功：access_token/openid 走 query，映射为 NextAuth Profile", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        openid: "oOPENID",
        nickname: "张三",
        sex: 1,
        language: "zh_CN",
        city: "Shenzhen",
        province: "Guangdong",
        country: "CN",
        headimgurl: "https://thirdwx.qlogo.cn/xxx",
        privilege: ["UNION_ID"],
        unionid: "oUNIONID",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const profile = await fetchWeChatUserInfo({
      accessToken: "ACCESS_TOKEN",
      openid: "oOPENID",
    });

    expect(profile).toEqual({
      // sub/name 是 NextAuth Profile 的已知属性
      sub: "oOPENID",
      name: "张三",
      openid: "oOPENID",
      nickname: "张三",
      headimgurl: "https://thirdwx.qlogo.cn/xxx",
    });

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/sns/userinfo");
    expect(url.searchParams.get("access_token")).toBe("ACCESS_TOKEN");
    expect(url.searchParams.get("openid")).toBe("oOPENID");
  });

  it("access_token 失效（errcode 40001）：抛错并带 errcode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          errcode: 40001,
          errmsg: "invalid credential, access_token is invalid or not latest",
        }),
      ),
    );

    await expect(
      fetchWeChatUserInfo({
        accessToken: "EXPIRED",
        openid: "oOPENID",
      }),
    ).rejects.toThrow(/40001.*invalid credential/);
  });

  it("响应缺 openid：抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ nickname: "张三" })),
    );

    await expect(
      fetchWeChatUserInfo({
        accessToken: "ACCESS_TOKEN",
        openid: "oOPENID",
      }),
    ).rejects.toThrow(/userinfo failed/);
  });
});

describe("wechatEmailFromOpenid", () => {
  it("微信不提供 email，以 openid 合成", () => {
    expect(wechatEmailFromOpenid("oABC123")).toBe(
      `oABC123@${WECHAT_EMAIL_DOMAIN}`,
    );
  });
});
