// 微信扫码登录协议交互（微信开放平台「网站应用」scope=snsapi_login）。
// 微信协议非标准 OAuth2：token 端点为 GET + query 参数且返回 JSON、
// userinfo 的 access_token/openid 走 query、且不提供 email —— 故 email
// 以 openid 合成。由 server/auth.ts 的 wechat 自定义 provider 调用。

/** 合成 email 用的域名（微信不提供 email） */
export const WECHAT_EMAIL_DOMAIN = "wechat-users.saiye.local";

export function wechatEmailFromOpenid(openid: string): string {
  return `${openid}@${WECHAT_EMAIL_DOMAIN}`;
}

export interface WeChatTokens {
  // 索引签名：兼容 NextAuth 的 TokenSetParameters（Record<string, unknown>）
  [key: string]: unknown;
  access_token: string;
  token_type: string;
  expires_in?: number;
  openid: string;
}

export interface WeChatProfile {
  sub: string;
  name?: string;
  nickname?: string;
  openid: string;
  headimgurl?: string;
}

/** 用授权 code 换 access_token。微信错误以 errcode/errmsg 返回（HTTP 也可能为 200）。 */
export async function fetchWeChatAccessToken(opts: {
  appId: string;
  appSecret: string;
  code: string;
}): Promise<WeChatTokens> {
  const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  url.searchParams.set("appid", opts.appId);
  url.searchParams.set("secret", opts.appSecret);
  url.searchParams.set("code", opts.code);
  url.searchParams.set("grant_type", "authorization_code");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    openid?: string;
    errcode?: number;
    errmsg?: string;
  };
  if (!res.ok || !json.access_token || !json.openid) {
    throw new Error(
      `WeChat token exchange failed: ${json.errcode ?? res.status} ${json.errmsg ?? ""}`,
    );
  }
  return {
    access_token: json.access_token,
    token_type: "Bearer",
    expires_in: json.expires_in,
    openid: json.openid,
  };
}

/** 拉取微信用户信息。返回的 sub/name 是 NextAuth Profile 的已知属性，保证类型兼容。 */
export async function fetchWeChatUserInfo(opts: {
  accessToken: string;
  openid: string;
}): Promise<WeChatProfile> {
  const url = new URL("https://api.weixin.qq.com/sns/userinfo");
  url.searchParams.set("access_token", opts.accessToken);
  url.searchParams.set("openid", opts.openid);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const json = (await res.json()) as {
    openid?: string;
    nickname?: string;
    headimgurl?: string;
    errcode?: number;
    errmsg?: string;
  };
  if (!res.ok || !json.openid) {
    throw new Error(
      `WeChat userinfo failed: ${json.errcode ?? res.status} ${json.errmsg ?? ""}`,
    );
  }
  return {
    sub: json.openid,
    name: json.nickname,
    openid: json.openid,
    nickname: json.nickname,
    headimgurl: json.headimgurl,
  };
}
