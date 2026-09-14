/**
 * 桥侧滑动窗口限流（docs/WIDGET_WRITE_API_DESIGN.md §8.2，D17）：
 * 每个组件实例独立计数，L1 写 60 次/分钟、L2 删 10 次/分钟，超出回 rate_limited。
 * 内存态（刷新即重置）——防的是失控循环而非恶意滥用，够用；
 * 服务端不额外按 widget 维度限流（沿用既有全局限流）。
 */

export const WIDGET_RATE_LIMITS = {
  write: 60,
  delete: 10,
} as const;

export const WIDGET_RATE_WINDOW_MS = 60_000;

export type WidgetRateTier = keyof typeof WIDGET_RATE_LIMITS;

/**
 * 创建一个滑动窗口计数器（时间可注入，便于单测模拟时钟）。
 */
export function createWidgetRateLimiter(now: () => number = () => Date.now()) {
  const stamps = new Map<WidgetRateTier, number[]>();

  /**
   * 记录一次调用并判断是否放行。
   * @returns true=放行；false=窗口内已满
   */
  function consume(tier: WidgetRateTier): boolean {
    const t = now();
    const windowStart = t - WIDGET_RATE_WINDOW_MS;
    const recent = (stamps.get(tier) ?? []).filter((s) => s > windowStart);
    if (recent.length >= WIDGET_RATE_LIMITS[tier]) {
      stamps.set(tier, recent);
      return false;
    }
    recent.push(t);
    stamps.set(tier, recent);
    return true;
  }

  return { consume };
}
