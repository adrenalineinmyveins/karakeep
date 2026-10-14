import { and, eq, inArray } from "drizzle-orm";
import cron from "node-cron";

import { db } from "@saiye/db";
import { agentProfiles, agentPublications } from "@saiye/db/schema";
import logger from "@saiye/shared/logger";

import type { AgentOnlineState } from "@saiye/shared/types/agentProfiles";

/**
 * D1 在线状态：对已发布的外部大脑（openai-compatible）定期探活。
 * GET {baseUrl}/models（带 Bearer apiKey，10s 超时）——2xx/401 均视为
 * 端点在线（401 说明服务活着只是鉴权姿势不同），网络错误/超时为离线。
 * hosted 恒在线（不落库）；trae-cli 运行在所有者本地（不可探，恒 unknown）。
 */

/** 单个探活的超时（ms） */
const HEALTHCHECK_TIMEOUT_MS = 10_000;

async function probeProfile(profile: {
  id: string;
  baseUrl: string | null;
  apiKey: string | null;
}): Promise<AgentOnlineState> {
  const url = profile.baseUrl
    ? `${profile.baseUrl.replace(/\/$/, "")}/models`
    : null;
  if (!url) {
    return { state: "offline", checkedAt: Date.now() };
  }
  try {
    const resp = await fetch(url, {
      headers: profile.apiKey
        ? { Authorization: `Bearer ${profile.apiKey}` }
        : undefined,
      signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
    });
    // 2xx 正常；401/403 说明端点活着（鉴权拒绝≠不可达）
    const online = resp.ok || resp.status === 401 || resp.status === 403;
    return { state: online ? "online" : "offline", checkedAt: Date.now() };
  } catch {
    return { state: "offline", checkedAt: Date.now() };
  }
}

/** 扫描 published 的 openai-compatible 发布对应的档案并探活落库 */
export async function runAgentHealthChecks(): Promise<{ checked: number }> {
  // 已发布的外部大脑档案（distinct：一个档案至多一个发布）
  const profiles = await db
    .selectDistinct({
      id: agentProfiles.id,
      baseUrl: agentProfiles.baseUrl,
      apiKey: agentProfiles.apiKey,
    })
    .from(agentPublications)
    .innerJoin(
      agentProfiles,
      eq(agentProfiles.id, agentPublications.agentProfileId),
    )
    .where(
      and(
        inArray(agentPublications.status, ["published", "delisting"]),
        eq(agentProfiles.type, "openai-compatible"),
      ),
    );

  let online = 0;
  for (const profile of profiles) {
    const state = await probeProfile(profile);
    if (state.state === "online") {
      online++;
    }
    await db
      .update(agentProfiles)
      .set({ onlineState: state })
      .where(eq(agentProfiles.id, profile.id));
  }

  if (profiles.length > 0) {
    logger.info(
      `[agentHealth] Checked ${profiles.length} external runtimes: ${online} online, ${profiles.length - online} offline`,
    );
  }
  return { checked: profiles.length };
}

/** 每 10 分钟探活一轮（D1 在线状态数据源） */
export const AgentHealthSchedulingWorker = cron.schedule(
  "*/10 * * * *",
  () => {
    runAgentHealthChecks().catch((e) => {
      logger.error(`[agentHealth] Health check run failed: ${e}`);
    });
  },
  {
    runOnInit: false,
    scheduled: false,
  },
);
