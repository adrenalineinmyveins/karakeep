import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import type { RateLimitConfig } from "@saiye/shared/ratelimiting";
import serverConfig from "@saiye/shared/config";
import { getRateLimitClient } from "@saiye/shared/ratelimiting";
import { Context } from "@saiye/trpc";

export function createRateLimitMiddleware(config: RateLimitConfig) {
  return createMiddleware<{
    Variables: {
      ctx: Context;
    };
  }>(async (c, next) => {
    if (!serverConfig.rateLimiting.enabled) {
      return next();
    }

    const ip = c.var.ctx.req.ip;
    if (!ip) {
      return next();
    }

    const client = await getRateLimitClient();
    if (!client) {
      return next();
    }

    const userSegment = c.var.ctx.user?.id ? `:user:${c.var.ctx.user.id}` : "";
    const key = `${ip}${userSegment}:${config.name}`;
    const result = await client.checkRateLimit(config, key);

    if (!result.allowed) {
      throw new HTTPException(429, {
        message: `Rate limit exceeded. Try again in ${result.resetInSeconds} seconds.`,
      });
    }

    return next();
  });
}
