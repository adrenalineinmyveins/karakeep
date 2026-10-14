import type { RedisClientType } from "redis";
import { createClient } from "redis";

import serverConfig from "@saiye/shared/config";
import { throttledLogger } from "@saiye/shared/logger";

/**
 * D5 实时推送事件类型。
 * - consult_incoming：被咨询方（发布者）收到新咨询 → 刷新收件箱
 * - consult_outgoing：请求方收到执行结果（answered/need_input/failed/expired）→ 刷新发件箱
 */
export type RealtimeEvent =
  | { type: "consult_incoming" }
  | { type: "consult_outgoing" };

/** 跨进程实时消息代理：有 Redis 走 Pub/Sub，无 Redis 内存降级（仅同进程） */
export interface RealtimeBroker {
  publish(userId: string, event: RealtimeEvent): Promise<void>;
  /** 返回同步 unsubscribe；同 userId 可注册多个 handler */
  subscribe(
    userId: string,
    handler: (event: RealtimeEvent) => void,
  ): () => void;
}

const CHANNEL_PREFIX = "realtime:user:";

function channelName(userId: string): string {
  return `${CHANNEL_PREFIX}${userId}`;
}

/** 进程内降级实现：单进程内直接分发（无 Redis 时用，跨进程即时性由前端轮询兜底） */
class InMemoryRealtimeBroker implements RealtimeBroker {
  private handlers = new Map<string, Set<(event: RealtimeEvent) => void>>();

  async publish(userId: string, event: RealtimeEvent): Promise<void> {
    const set = this.handlers.get(userId);
    if (!set) return;
    for (const handler of set) {
      handler(event);
    }
  }

  subscribe(
    userId: string,
    handler: (event: RealtimeEvent) => void,
  ): () => void {
    let set = this.handlers.get(userId);
    if (!set) {
      set = new Set();
      this.handlers.set(userId, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(userId);
      }
    };
  }
}

/** Redis Pub/Sub 实现：publisher + subscriber 双连接，worker 与 web 跨进程实时 */
class RedisRealtimeBroker implements RealtimeBroker {
  private handlers = new Map<string, Set<(event: RealtimeEvent) => void>>();
  private subscribed = new Set<string>();
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private failOpenLog = throttledLogger(30_000);

  constructor(url: string) {
    const opts = {
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: () => 3_000 },
    };
    this.publisher = createClient(opts);
    this.subscriber = createClient(opts);

    for (const client of [this.publisher, this.subscriber]) {
      client.on("error", (e) => {
        this.failOpenLog("warn", `Realtime Redis client error: ${String(e)}`);
      });
    }

    // 连接为 fire-and-forget：失败时 fail-open，前端 15s 轮询兜底
    this.publisher
      .connect()
      .catch((e) =>
        this.failOpenLog(
          "warn",
          `Realtime publisher connect failed: ${String(e)}`,
        ),
      );
    this.subscriber
      .connect()
      .catch((e) =>
        this.failOpenLog(
          "warn",
          `Realtime subscriber connect failed: ${String(e)}`,
        ),
      );
  }

  private dispatch(channel: string, raw: string): void {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const userId = channel.slice(CHANNEL_PREFIX.length);
    const set = this.handlers.get(userId);
    if (!set || set.size === 0) return;
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch (e) {
      this.failOpenLog(
        "warn",
        `Realtime invalid payload on ${channel}: ${String(e)}`,
      );
      return;
    }
    for (const handler of set) {
      handler(event);
    }
  }

  async publish(userId: string, event: RealtimeEvent): Promise<void> {
    try {
      await this.publisher.publish(channelName(userId), JSON.stringify(event));
    } catch (e) {
      // fail-open：推送失败静默降级，前端轮询兜底
      this.failOpenLog(
        "warn",
        `Realtime publish ${userId} failed: ${String(e)}`,
      );
    }
  }

  subscribe(
    userId: string,
    handler: (event: RealtimeEvent) => void,
  ): () => void {
    let set = this.handlers.get(userId);
    if (!set) {
      set = new Set();
      this.handlers.set(userId, set);
    }
    set.add(handler);

    const channel = channelName(userId);
    // 首次注册：向 Redis 订阅该 channel（断线重连时 node-redis 自动重订）
    if (!this.subscribed.has(channel)) {
      this.subscribed.add(channel);
      this.subscriber
        .subscribe(channel, (raw, chan) => this.dispatch(chan, raw))
        .catch((e) => {
          this.failOpenLog(
            "warn",
            `Realtime subscribe ${channel} failed: ${String(e)}`,
          );
        });
    }

    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(userId);
        this.subscribed.delete(channel);
        this.subscriber.unsubscribe(channel).catch((e) => {
          this.failOpenLog(
            "warn",
            `Realtime unsubscribe ${channel} failed: ${String(e)}`,
          );
        });
      }
    };
  }
}

let broker: RealtimeBroker | null = null;

/** 懒初始化进程级单例：有 REDIS_URL 走 Redis，否则内存降级 */
export function getRealtimeBroker(): RealtimeBroker {
  if (!broker) {
    broker = serverConfig.redis.url
      ? new RedisRealtimeBroker(serverConfig.redis.url)
      : new InMemoryRealtimeBroker();
  }
  return broker;
}
