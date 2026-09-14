import { describe, expect, test } from "vitest";

import {
  WIDGET_RATE_LIMITS,
  WIDGET_RATE_WINDOW_MS,
  createWidgetRateLimiter,
} from "./rateLimit";

describe("widget 桥侧限流（W3，§8.2）", () => {
  test("L1 write：60 次/分钟，第 61 次拒绝", () => {
    let now = 1_000_000;
    const limiter = createWidgetRateLimiter(() => now);
    for (let i = 0; i < WIDGET_RATE_LIMITS.write; i++) {
      expect(limiter.consume("write")).toBe(true);
    }
    expect(limiter.consume("write")).toBe(false);
  });

  test("L2 delete：10 次/分钟，第 11 次拒绝", () => {
    let now = 1_000_000;
    const limiter = createWidgetRateLimiter(() => now);
    for (let i = 0; i < WIDGET_RATE_LIMITS.delete; i++) {
      expect(limiter.consume("delete")).toBe(true);
    }
    expect(limiter.consume("delete")).toBe(false);
  });

  test("滑动窗口：满 60 秒后旧记录过期，重新放行", () => {
    let now = 1_000_000;
    const limiter = createWidgetRateLimiter(() => now);
    for (let i = 0; i < WIDGET_RATE_LIMITS.write; i++) {
      expect(limiter.consume("write")).toBe(true);
    }
    expect(limiter.consume("write")).toBe(false);
    // 推进整整一个窗口：最早的时间戳滑出窗口
    now += WIDGET_RATE_WINDOW_MS + 1;
    expect(limiter.consume("write")).toBe(true);
  });

  test("write 与 delete 独立计数", () => {
    const limiter = createWidgetRateLimiter(() => 1_000_000);
    // 写打满不影响删除配额
    for (let i = 0; i < WIDGET_RATE_LIMITS.write; i++) {
      limiter.consume("write");
    }
    expect(limiter.consume("write")).toBe(false);
    expect(limiter.consume("delete")).toBe(true);
  });

  test("两个限流器实例互不影响（组件实例独立配额）", () => {
    const limiterA = createWidgetRateLimiter(() => 1_000_000);
    const limiterB = createWidgetRateLimiter(() => 1_000_000);
    for (let i = 0; i < WIDGET_RATE_LIMITS.delete; i++) {
      limiterA.consume("delete");
    }
    expect(limiterA.consume("delete")).toBe(false);
    expect(limiterB.consume("delete")).toBe(true);
  });
});
