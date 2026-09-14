import { z } from "zod";

/**
 * C1 资产导出/导入：三类 agent 配置资产（agentProfile / widget / prompt）
 * 的统一导出信封。apiKey 等敏感字段永不进入导出内容。
 */
export const ASSET_EXPORT_TYPES = ["agentProfile", "widget", "prompt"] as const;
export type AssetExportType = (typeof ASSET_EXPORT_TYPES)[number];

export const ASSET_EXPORT_TYPE = "saiye.asset-export" as const;

/** 导出信封（data 由各 router 用对应 schema 二次校验） */
export const zAssetExportEnvelopeSchema = z.object({
  type: z.literal(ASSET_EXPORT_TYPE),
  version: z.literal(1),
  assetType: z.enum(ASSET_EXPORT_TYPES),
  exportedAt: z.string(),
  data: z.unknown(),
});

export type AssetExportEnvelope = z.infer<typeof zAssetExportEnvelopeSchema>;

/** 构造信封（导出侧共用） */
export function buildAssetExportEnvelope(
  assetType: AssetExportType,
  data: unknown,
): AssetExportEnvelope {
  return {
    type: ASSET_EXPORT_TYPE,
    version: 1,
    assetType,
    exportedAt: new Date().toISOString(),
    data,
  };
}
