import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";

import SaiyeLogo from "@/components/SaiyeIcon";
import ShareForkButton from "@/components/shared/ShareForkButton";
import { buttonVariants } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/server";
import { api } from "@/server/api/client";
import { getServerAuthSession } from "@/server/auth";

import type { AssetExportType } from "@saiye/shared/types/assetExport";

export async function generateMetadata(props: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await props.params;
  try {
    const resp = await api.publicSharedAssets.get({ token });
    return {
      title: `${resp.name} by ${resp.ownerName} - Saiye`,
      applicationName: "Saiye",
    };
  } catch {
    return { title: "Saiye" };
  }
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  );
}

/** 按资产类型渲染快照预览（widget 代码只展示不执行） */
async function AssetPreview({
  assetType,
  payload,
}: {
  assetType: AssetExportType;
  payload: unknown;
}) {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  const sa = "shared_assets";
  const data = (payload ?? {}) as Record<string, unknown>;
  switch (assetType) {
    case "agentProfile": {
      const type = data.type as string;
      return (
        <div className="divide-y">
          <DetailRow
            label={t(`${sa}.type`)}
            value={
              type === "openai-compatible"
                ? t(`${sa}.type_openai_compatible`)
                : t(`${sa}.type_trae_cli`)
            }
          />
          {type === "openai-compatible" ? (
            <>
              <DetailRow
                label={t(`${sa}.base_url`)}
                value={String(data.baseUrl ?? "")}
              />
              <DetailRow
                label={t(`${sa}.model`)}
                value={String(data.model ?? "")}
              />
            </>
          ) : (
            <>
              <DetailRow
                label={t(`${sa}.command`)}
                value={String(data.command ?? "")}
              />
              <DetailRow
                label={t(`${sa}.timeout_minutes`)}
                value={String(data.timeoutMinutes ?? 5)}
              />
            </>
          )}
          {data.systemPrompt ? (
            <DetailRow
              label={t(`${sa}.system_prompt`)}
              value={
                <pre className="whitespace-pre-wrap font-sans">
                  {String(data.systemPrompt)}
                </pre>
              }
            />
          ) : null}
          <DetailRow
            label={t(`${sa}.api_key_excluded`)}
            value={t(`${sa}.not_included`)}
          />
        </div>
      );
    }
    case "widget": {
      const manifest = (data.manifest ?? {}) as Record<string, unknown>;
      const permissions = Array.isArray(manifest.permissions)
        ? (manifest.permissions as string[]).join(", ")
        : "";
      return (
        <div className="divide-y">
          {data.description ? (
            <DetailRow
              label={t(`${sa}.description`)}
              value={String(data.description)}
            />
          ) : null}
          <DetailRow
            label={t(`${sa}.permissions`)}
            value={permissions || "—"}
          />
          <DetailRow
            label={t(`${sa}.code_preview`)}
            value={
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                {String(data.code ?? "").slice(0, 1000)}
              </pre>
            }
          />
        </div>
      );
    }
    case "prompt": {
      return (
        <div className="divide-y">
          <DetailRow
            label={t(`${sa}.prompt_text`)}
            value={
              <pre className="whitespace-pre-wrap font-sans">
                {String(data.text ?? "")}
              </pre>
            }
          />
          <DetailRow
            label={t(`${sa}.applies_to`)}
            value={String(data.appliesTo ?? "")}
          />
          <DetailRow
            label={t(`${sa}.status`)}
            value={data.enabled ? t(`${sa}.enabled`) : t(`${sa}.disabled`)}
          />
        </div>
      );
    }
  }
}

const TYPE_LABEL_KEYS = {
  agentProfile: "shared_assets.type_agent_profile",
  widget: "shared_assets.type_widget",
  prompt: "shared_assets.type_prompt",
} as const;

export default async function SharedAssetPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  const session = await getServerAuthSession();

  let data;
  try {
    data = await api.publicSharedAssets.get({ token });
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") {
      notFound();
    }
    throw e;
  }

  const sa = "shared_assets";

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="rounded-lg border bg-gradient-to-br from-purple-50/50 via-purple-100/30 to-purple-200/40 p-6 transition-all duration-300 dark:from-purple-950/20 dark:via-purple-900/15 dark:to-purple-800/20">
        <div className="space-y-4">
          <SaiyeLogo height={38} />
          <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t(TYPE_LABEL_KEYS[data.assetType])}
              </p>
              <h1 className="text-2xl font-bold leading-tight text-foreground md:text-3xl">
                {data.name}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(`${sa}.shared_by`, { name: data.ownerName })} ·{" "}
                {data.createdAt.toLocaleDateString()}
              </p>
            </div>
            {session ? (
              <ShareForkButton token={token} />
            ) : (
              <Link
                href="/signin"
                className={buttonVariants({ variant: "outline" })}
              >
                {t(`${sa}.sign_in_to_fork`)}
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <AssetPreview assetType={data.assetType} payload={data.payload} />
      </div>
    </div>
  );
}
