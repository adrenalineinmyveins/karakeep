import { randomBytes } from "crypto";
import { Adapter, AdapterUser } from "@auth/core/adapters";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { count, eq } from "drizzle-orm";
import NextAuth, {
  DefaultSession,
  getServerSession,
  NextAuthOptions,
  type Session,
} from "next-auth";
import { Adapter as NextAuthAdapater } from "next-auth/adapters";
import CredentialsProvider from "next-auth/providers/credentials";
import { Provider } from "next-auth/providers/index";
import requestIp from "request-ip";

import { db } from "@saiye/db";
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@saiye/db/schema";
import serverConfig from "@saiye/shared/config";
import { getRateLimitClient } from "@saiye/shared/ratelimiting";
import {
  containsUnsafeUserNameMarkup,
  normalizeUserNameInput,
} from "@saiye/shared/utils/userName";
import { logEvent } from "@saiye/shared-server";
import {
  generatePasswordSalt,
  hashPassword,
  validatePassword,
} from "@saiye/trpc/auth";
import { User } from "@saiye/trpc/models/users";
import {
  fetchWeChatAccessToken,
  fetchWeChatUserInfo,
  wechatEmailFromOpenid,
} from "./wechat";

type UserRole = "admin" | "user";

declare module "next-auth/jwt" {
  export interface JWT {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }
}

declare module "next-auth" {
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  export interface Session {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }

  export interface DefaultUser {
    role: UserRole | null;
  }
}

/**
 * Returns true if the user table is empty, which indicates that this user is going to be
 * the first one. This can be racy if multiple users are created at the same time, but
 * that should be fine.
 */
async function isFirstUser(): Promise<boolean> {
  const [{ count: userCount }] = await db
    .select({ count: count() })
    .from(users);
  return userCount == 0;
}

/**
 * Returns true if the user is an admin
 */
async function isAdmin(email: string): Promise<boolean> {
  const res = await db.query.users.findFirst({
    columns: { role: true },
    where: eq(users.email, email),
  });
  return res?.role == "admin";
}

const DEFAULT_DISPLAY_NAME = "User";

function normalizeSafeDisplayName(name: string | null | undefined): string {
  const normalizedName = normalizeUserNameInput(name ?? "");
  return !containsUnsafeUserNameMarkup(name ?? "") && normalizedName
    ? normalizedName
    : DEFAULT_DISPLAY_NAME;
}

const CustomProvider = (): Adapter => {
  const adapter = DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });

  return {
    ...adapter,
    createUser: async (user: Omit<AdapterUser, "id">) => {
      const created = await User.createRaw(db, {
        name: normalizeSafeDisplayName(user.name),
        email: user.email,
        emailVerified: user.emailVerified,
      });
      logEvent({
        "event.name": "user.signup",
        "user.id": created.id,
        "auth.provider": "oauth",
      });
      return created;
    },
  };
};

const providers: Provider[] = [
  CredentialsProvider({
    // The name to display on the sign in form (e.g. "Sign in with...")
    name: "Credentials",
    credentials: {
      email: { label: "Email", type: "email", placeholder: "Email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials, req) {
      if (!credentials) {
        return null;
      }

      if (serverConfig.rateLimiting.enabled) {
        const ip = requestIp.getClientIp({ headers: req?.headers ?? {} });
        const client = ip ? await getRateLimitClient() : null;
        if (client) {
          const result = await client.checkRateLimit(
            { name: "auth.login", windowMs: 15 * 60 * 1000, maxRequests: 10 },
            `login:${ip}:${credentials.email.toLowerCase()}`,
          );
          if (!result.allowed) {
            logEvent({
              "event.name": "user.login_failed",
              "user.email": credentials.email,
              "auth.failure_reason": "rate_limited",
            });
            throw new Error("Too many login attempts. Please try again later.");
          }
        }
      }

      try {
        return await validatePassword(
          credentials?.email,
          credentials?.password,
          db,
        );
      } catch (e) {
        logEvent({
          "event.name": "user.login_failed",
          "user.email": credentials?.email,
          "auth.failure_reason":
            e instanceof Error ? e.message : "invalid_credentials",
        });
        return null;
      }
    },
  }),
];

const wechat = serverConfig.auth.wechat;
if (wechat.appId && wechat.appSecret) {
  // 微信开放平台「网站应用」扫码登录（scope=snsapi_login）。
  // 协议交互（GET token/JSON/合成 email）见 server/wechat.ts；
  // 桌面/内网场景通过 WECHAT_REDIRECT_URI 指向公网中转
  // （apps/desktop/relay），由中转 302 回本机 NextAuth 回调。
  providers.push({
    id: "wechat",
    name: "微信扫码",
    type: "oauth",
    clientId: wechat.appId,
    clientSecret: wechat.appSecret,
    authorization: {
      url: "https://open.weixin.qq.com/connect/qrconnect",
      params: {
        appid: wechat.appId,
        response_type: "code",
        scope: "snsapi_login",
        ...(wechat.redirectUri ? { redirect_uri: wechat.redirectUri } : {}),
      },
    },
    // 微信不支持 PKCE 参数，仅用 state 防 CSRF
    checks: ["state"],
    token: {
      async request({ params }) {
        const tokens = await fetchWeChatAccessToken({
          appId: wechat.appId!,
          appSecret: wechat.appSecret!,
          code: String(params.code),
        });
        return { tokens };
      },
    },
    userinfo: {
      async request({ tokens }) {
        return fetchWeChatUserInfo({
          accessToken: String(tokens.access_token),
          openid: String(tokens.openid),
        });
      },
    },
    async profile(profile: {
      openid: string;
      nickname?: string;
      headimgurl?: string;
    }) {
      const email = wechatEmailFromOpenid(profile.openid);
      const [admin, firstUser] = await Promise.all([
        isAdmin(email),
        isFirstUser(),
      ]);
      return {
        id: profile.openid,
        name: normalizeSafeDisplayName(profile.nickname ?? null),
        email,
        image: profile.headimgurl,
        role: admin || firstUser ? "admin" : "user",
      };
    },
  });
}

const oauth = serverConfig.auth.oauth;
if (oauth.wellKnownUrl) {
  providers.push({
    id: "custom",
    name: oauth.name,
    type: "oauth",
    wellKnown: oauth.wellKnownUrl,
    authorization: { params: { scope: oauth.scope } },
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    ...(oauth.idTokenSignedResponseAlg
      ? {
          client: {
            id_token_signed_response_alg: oauth.idTokenSignedResponseAlg,
          },
        }
      : {}),
    allowDangerousEmailAccountLinking: oauth.allowDangerousEmailAccountLinking,
    checks: ["pkce", "state"],
    httpOptions: {
      timeout: oauth.timeout,
    },
    async profile(profile: Record<string, string>) {
      const [admin, firstUser] = await Promise.all([
        isAdmin(profile.email),
        isFirstUser(),
      ]);

      return {
        id: profile.sub,
        name: normalizeSafeDisplayName(profile.name),
        email: profile.email,
        role: admin || firstUser ? "admin" : "user",
      };
    },
  });
}

export const authOptions: NextAuthOptions = {
  // https://github.com/nextauthjs/next-auth/issues/9493
  adapter: CustomProvider() as NextAuthAdapater,
  providers: providers,
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/signin",
    signOut: "/signin",
    error: "/signin",
    newUser: "/signin",
  },
  callbacks: {
    async signIn({ user: credUser, credentials, profile }) {
      const email = credUser.email || profile?.email;
      if (!email) {
        throw new Error("Provider didn't provide an email during signin");
      }
      const user = await db.query.users.findFirst({
        columns: { id: true, emailVerified: true },
        where: eq(users.email, email),
      });

      if (credentials) {
        if (!user) {
          logEvent({
            "event.name": "user.login_failed",
            "user.email": email,
            "auth.failure_reason": "invalid_credentials",
          });
          throw new Error("Invalid credentials");
        }
        if (
          serverConfig.auth.emailVerificationRequired &&
          !user.emailVerified
        ) {
          logEvent({
            "event.name": "user.login_failed",
            "user.email": email,
            "auth.failure_reason": "email_not_verified",
          });
          throw new Error("Please verify your email address before signing in");
        }
        logEvent({
          "event.name": "user.login",
          "user.id": user.id,
          "auth.provider": "credentials",
        });
        return true;
      }

      // If it's a new user and signups are disabled, fail the sign in
      if (!user && serverConfig.auth.disableSignups) {
        logEvent({
          "event.name": "user.signup",
          "auth.provider": "oauth",
          "auth.failure_reason": "signups_disabled",
        });
        throw new Error("Signups are disabled in server config");
      }

      // TODO: We're blindly trusting oauth providers to validate emails
      // As such, oauth users can sign in even if email verification is enabled.
      // We might want to change this in the future.

      if (user) {
        logEvent({
          "event.name": "user.login",
          "user.id": user.id,
          "auth.provider": "oauth",
        });
      }

      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.user = {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          role: user.role ?? "user",
        };
      }
      return token;
    },
    async session({ session, token }) {
      session.user = { ...token.user };
      return session;
    },
  },
};

export const authHandler = NextAuth(authOptions);

// ─── 桌面本地模式（SAIYE_LOCAL_MODE=true）──────────────────
// 单机桌面部署信任 loopback：会话解析收口于此，本地模式直接返回
// 合成 session（JWT 策略下无法向外部浏览器注入 cookie，故走旁路）。
// 首个请求懒创建本地 admin 用户；服务端默认行为不受影响。
const LOCAL_USER_EMAIL = "local@desktop.saiye.local";

async function getLocalModeSession() {
  let user = await db.query.users.findFirst({
    where: eq(users.email, LOCAL_USER_EMAIL),
  });
  if (!user) {
    user = await User.createRaw(db, {
      name: "Local User",
      email: LOCAL_USER_EMAIL,
      // 随机不可用密码：本地用户不走凭据登录
      password: await hashPassword(
        randomBytes(32).toString("hex"),
        generatePasswordSalt(),
      ),
      emailVerified: new Date(),
    });
  }
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role ?? "user",
    },
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export const getServerAuthSession = async (): Promise<Session | null> => {
  if (serverConfig.auth.localMode) {
    return await getLocalModeSession();
  }
  return await getServerSession(authOptions);
};
