"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  BadgeCheck,
  Download,
  Globe,
  Hourglass,
  Pencil,
  PlusCircle,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import AssetShareButtons from "@/components/shared/AssetShareButtons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  downloadJsonFile,
  readJsonFile,
  safeFilenamePart,
} from "@/lib/assetTransfer";
import { useTranslation } from "@/lib/i18n/client";
import { useTRPC } from "@saiye/shared-react/trpc";
import { AGENT_PROFILE_TYPES } from "@saiye/shared/types/agentProfiles";
import type {
  AgentProfileType,
  KnowledgeScope,
} from "@saiye/shared/types/agentProfiles";
import { Badge } from "@/components/ui/badge";

/** list 返回的安全档案（无 apiKey，只有 hasApiKey 布尔） */
interface AgentProfileRow {
  id: string;
  name: string;
  type: AgentProfileType;
  baseUrl: string | null;
  model: string | null;
  command: string | null;
  timeoutMinutes: number;
  systemPrompt: string | null;
  enableTools: boolean;
  knowledgeScope: KnowledgeScope | null;
  hasApiKey: boolean;
}

/** 受控表单状态（两种类型的字段摊平，提交时按 type 组装判别联合） */
interface ProfileFormState {
  type: AgentProfileType;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  command: string;
  timeoutMinutes: string;
  systemPrompt: string;
  enableTools: boolean;
  /** per-profile 语料范围：选中的标签/清单 id（提交时组装 knowledgeScope） */
  scopeTagIds: string[];
  scopeListIds: string[];
}

const emptyForm: ProfileFormState = {
  type: "openai-compatible",
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  command: "",
  timeoutMinutes: "5",
  systemPrompt: "",
  enableTools: true,
  scopeTagIds: [],
  scopeListIds: [],
};

/** trae-cli 分支的超时字段（合法整数才带上，否则走后端默认 5 分钟） */
function timeouts(form: ProfileFormState) {
  const minutes = Number.parseInt(form.timeoutMinutes, 10);
  return Number.isFinite(minutes) ? { timeoutMinutes: minutes } : {};
}

function ProfileFormDialog({
  profile,
  open,
  onOpenChange,
}: {
  /** null = 新建 */
  profile: AgentProfileRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const [form, setForm] = useState<ProfileFormState>(emptyForm);

  // 标签/清单（语料范围选择用；对话框打开时才拉取）
  const tagsQuery = useQuery({
    ...api.tags.list.queryOptions(),
    enabled: open,
  });
  const listsQuery = useQuery({
    ...api.lists.list.queryOptions(),
    enabled: open,
  });

  // 打开时按档案初始化（编辑不回显 apiKey）
  useEffect(() => {
    if (!open) return;
    setForm(
      profile
        ? {
            type: profile.type,
            name: profile.name,
            baseUrl: profile.baseUrl ?? "",
            apiKey: "",
            model: profile.model ?? "",
            command: profile.command ?? "",
            timeoutMinutes: String(profile.timeoutMinutes),
            systemPrompt: profile.systemPrompt ?? "",
            enableTools: profile.enableTools,
            scopeTagIds: profile.knowledgeScope?.tagIds ?? [],
            scopeListIds: profile.knowledgeScope?.listIds ?? [],
          }
        : emptyForm,
    );
  }, [open, profile]);

  const set = <K extends keyof ProfileFormState>(
    key: K,
    value: ProfileFormState[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  const handleSaved = (isUpdate: boolean) => {
    toast.success(
      isUpdate
        ? t("settings.agent_profiles.has_been_updated")
        : t("settings.agent_profiles.has_been_created"),
    );
    queryClient.invalidateQueries(api.agentProfiles.list.pathFilter());
    onOpenChange(false);
  };

  const createMutation = useMutation(
    api.agentProfiles.create.mutationOptions({
      onSuccess: () => handleSaved(false),
      onError: (e) => toast.error(e.message),
    }),
  );
  const updateMutation = useMutation(
    api.agentProfiles.update.mutationOptions({
      onSuccess: () => handleSaved(true),
      onError: (e) => toast.error(e.message),
    }),
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 语料范围：两者皆空 = null（全部书签语料）
    const knowledgeScope: KnowledgeScope | null =
      form.scopeTagIds.length > 0 || form.scopeListIds.length > 0
        ? { tagIds: form.scopeTagIds, listIds: form.scopeListIds }
        : null;
    const base = {
      name: form.name.trim(),
      systemPrompt: form.systemPrompt.trim() || null,
      enableTools: form.enableTools,
      knowledgeScope,
    };
    const input =
      form.type === "openai-compatible"
        ? {
            type: "openai-compatible" as const,
            ...base,
            baseUrl: form.baseUrl.trim(),
            model: form.model.trim(),
            ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
          }
        : {
            type: "trae-cli" as const,
            ...base,
            command: form.command.trim(),
            ...timeouts(form),
          };
    if (profile) {
      updateMutation.mutate({ ...input, id: profile.id });
    } else {
      createMutation.mutate(input);
    }
  };

  const tp = "settings.agent_profiles";
  const isEditing = !!profile;
  const hasApiKey = isEditing && profile.hasApiKey;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t(`${tp}.edit`) : t(`${tp}.create`)}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label>{t(`${tp}.type`)}</Label>
            <Select
              value={form.type}
              onValueChange={(v) => set("type", v as AgentProfileType)}
              disabled={isEditing}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_PROFILE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(
                      type === "openai-compatible"
                        ? `${tp}.type_openai_compatible`
                        : `${tp}.type_trae_cli`,
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="profile-name">{t(`${tp}.name`)}</Label>
            <Input
              id="profile-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              required
              maxLength={100}
            />
          </div>

          {form.type === "openai-compatible" ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="profile-base-url">{t(`${tp}.base_url`)}</Label>
                <Input
                  id="profile-base-url"
                  type="url"
                  placeholder="https://api.example.com/v1"
                  value={form.baseUrl}
                  onChange={(e) => set("baseUrl", e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="profile-api-key">{t(`${tp}.api_key`)}</Label>
                <Input
                  id="profile-api-key"
                  type="password"
                  placeholder={hasApiKey ? t(`${tp}.api_key_keep`) : "sk-..."}
                  value={form.apiKey}
                  onChange={(e) => set("apiKey", e.target.value)}
                  required={!isEditing}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="profile-model">{t(`${tp}.model`)}</Label>
                <Input
                  id="profile-model"
                  placeholder="gpt-4o-mini"
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
                  required
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="profile-command">{t(`${tp}.command`)}</Label>
                <Input
                  id="profile-command"
                  placeholder="traecli"
                  value={form.command}
                  onChange={(e) => set("command", e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {t(`${tp}.command_hint`)}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="profile-timeout">
                  {t(`${tp}.timeout_minutes`)}
                </Label>
                <Input
                  id="profile-timeout"
                  type="number"
                  min={1}
                  max={60}
                  value={form.timeoutMinutes}
                  onChange={(e) => set("timeoutMinutes", e.target.value)}
                />
              </div>
            </>
          )}

          <div className="grid gap-2">
            <Label htmlFor="profile-system-prompt">
              {t(`${tp}.system_prompt`)}
            </Label>
            <Textarea
              id="profile-system-prompt"
              rows={4}
              value={form.systemPrompt}
              onChange={(e) => set("systemPrompt", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t(`${tp}.system_prompt_hint`)}
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label>{t(`${tp}.enable_tools`)}</Label>
              <p className="text-xs text-muted-foreground">
                {t(`${tp}.enable_tools_hint`)}
              </p>
            </div>
            <Switch
              checked={form.enableTools}
              onCheckedChange={(v) => set("enableTools", v)}
            />
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label>{t(`${tp}.knowledge_scope`)}</Label>
              <p className="text-xs text-muted-foreground">
                {t(`${tp}.knowledge_scope_hint`)}
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t(`${tp}.knowledge_scope_tags`)}
              </p>
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {tagsQuery.data?.tags.length ? (
                  tagsQuery.data.tags.map((tag) => (
                    <Badge
                      key={tag.id}
                      variant={
                        form.scopeTagIds.includes(tag.id)
                          ? "default"
                          : "outline"
                      }
                      className="cursor-pointer select-none"
                      onClick={() =>
                        set(
                          "scopeTagIds",
                          form.scopeTagIds.includes(tag.id)
                            ? form.scopeTagIds.filter((id) => id !== tag.id)
                            : [...form.scopeTagIds, tag.id],
                        )
                      }
                    >
                      {tag.name}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t(`${tp}.knowledge_scope_no_tags`)}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t(`${tp}.knowledge_scope_lists`)}
              </p>
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                {listsQuery.data?.lists.length ? (
                  listsQuery.data.lists.map((list) => (
                    <Badge
                      key={list.id}
                      variant={
                        form.scopeListIds.includes(list.id)
                          ? "default"
                          : "outline"
                      }
                      className="cursor-pointer select-none"
                      onClick={() =>
                        set(
                          "scopeListIds",
                          form.scopeListIds.includes(list.id)
                            ? form.scopeListIds.filter((id) => id !== list.id)
                            : [...form.scopeListIds, list.id],
                        )
                      }
                    >
                      {list.icon} {list.name}
                    </Badge>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t(`${tp}.knowledge_scope_no_lists`)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {t("actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 发布表单状态（string 摊平，提交时转换；价格/封顶留空 = 不传走后端默认） */
interface PublishFormState {
  title: string;
  description: string;
  pricePerCall: string;
  billingCapPerSession: string;
}

/** 把表单数值字段转成 publish 输入（非法/留空 → 不带该字段） */
function optionalInt(value: string): number | undefined {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function PublishDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: AgentProfileRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const tp = "settings.agent_profiles";

  const [form, setForm] = useState<PublishFormState>({
    title: "",
    description: "",
    pricePerCall: "",
    billingCapPerSession: "",
  });

  // 打开时按档案初始化（标题默认用档案名）
  useEffect(() => {
    if (!open) return;
    setForm({
      title: profile?.name ?? "",
      description: "",
      pricePerCall: "",
      billingCapPerSession: "",
    });
  }, [open, profile]);

  const publishMutation = useMutation(
    api.agentPublications.publish.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${tp}.has_been_published`));
        queryClient.invalidateQueries(api.agentPublications.list.pathFilter());
        onOpenChange(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    publishMutation.mutate({
      agentProfileId: profile.id,
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      ...(optionalInt(form.pricePerCall) !== undefined
        ? { pricePerCall: optionalInt(form.pricePerCall) }
        : {}),
      ...(optionalInt(form.billingCapPerSession) !== undefined
        ? { billingCapPerSession: optionalInt(form.billingCapPerSession) }
        : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(`${tp}.publish`)}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="publish-title">{t(`${tp}.publish_title`)}</Label>
            <Input
              id="publish-title"
              value={form.title}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value }))
              }
              required
              maxLength={120}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="publish-description">
              {t(`${tp}.publish_description`)}
            </Label>
            <Textarea
              id="publish-description"
              rows={3}
              maxLength={2000}
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="publish-price">{t(`${tp}.publish_price`)}</Label>
            <Input
              id="publish-price"
              type="number"
              min={0}
              max={100000}
              value={form.pricePerCall}
              onChange={(e) =>
                setForm((f) => ({ ...f, pricePerCall: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              {t(`${tp}.publish_price_hint`)}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="publish-cap">
              {t(`${tp}.publish_billing_cap`)}
            </Label>
            <Input
              id="publish-cap"
              type="number"
              min={1}
              max={10000000}
              value={form.billingCapPerSession}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  billingCapPerSession: e.target.value,
                }))
              }
            />
            <p className="text-xs text-muted-foreground">
              {t(`${tp}.publish_billing_cap_hint`)}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={publishMutation.isPending}>
              {t(`${tp}.publish`)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentProfileSettings() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const tp = "settings.agent_profiles";

  const { data, isLoading } = useQuery(api.agentProfiles.list.queryOptions());
  // 发布状态（owner 全部发布；delisted 视为未发布，点发布按钮可复活）
  const publicationsQuery = useQuery(api.agentPublications.list.queryOptions());
  const pubByProfile = new Map(
    (publicationsQuery.data?.publications ?? [])
      .filter((pub) => pub.status !== "delisted")
      .map((pub) => [pub.agentProfileId, pub]),
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfileRow | null>(null);
  const [publishingProfile, setPublishingProfile] =
    useState<AgentProfileRow | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const invalidatePublications = () =>
    queryClient.invalidateQueries(api.agentPublications.list.pathFilter());

  const delistMutation = useMutation(
    api.agentPublications.delist.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${tp}.has_been_delisted`));
        invalidatePublications();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const restoreMutation = useMutation(
    api.agentPublications.restore.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${tp}.has_been_restored`));
        invalidatePublications();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const deleteMutation = useMutation(
    api.agentProfiles.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(api.agentProfiles.list.pathFilter());
      },
      onError: (e) => {
        toast.error(e.message);
      },
    }),
  );

  const exportMutation = useMutation(
    api.agentProfiles.exportAsset.mutationOptions({
      onSuccess: (envelope, variables) => {
        const name =
          profiles.find((p) => p.id === variables.id)?.name ?? "profile";
        downloadJsonFile(
          `saiye-agentProfile-${safeFilenamePart(name)}.json`,
          envelope,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const importMutation = useMutation(
    api.agentProfiles.importAsset.mutationOptions({
      onSuccess: (res) => {
        toast.success(
          res.needsApiKey
            ? t("assets.imported_needs_api_key")
            : t("assets.imported"),
        );
        queryClient.invalidateQueries(api.agentProfiles.list.pathFilter());
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const onImportFile = async (file: File) => {
    try {
      const envelope = await readJsonFile(file);
      importMutation.mutate({ envelope: envelope as never });
    } catch {
      toast.error(t("assets.invalid_file"));
    }
  };

  const profiles = data?.profiles ?? [];

  return (
    <>
      {isLoading ? null : profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(`${tp}.empty`)}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t(`${tp}.name`)}</TableHead>
              <TableHead>{t(`${tp}.type`)}</TableHead>
              <TableHead>{t(`${tp}.details`)}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles.map((p) => {
              const pub = pubByProfile.get(p.id);
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-1.5">
                      {p.name}
                      {pub?.status === "published" && (
                        <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600">
                          <BadgeCheck className="size-3.5" />
                          {t(`${tp}.published`)}
                        </span>
                      )}
                      {pub?.status === "delisting" && (
                        <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600">
                          <Hourglass className="size-3.5" />
                          {t(`${tp}.delisting`)}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    {t(
                      p.type === "openai-compatible"
                        ? `${tp}.type_openai_compatible`
                        : `${tp}.type_trae_cli`,
                    )}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {p.type === "openai-compatible"
                      ? `${p.model ?? ""} · ${p.baseUrl ?? ""}`
                      : `${p.command ?? ""} · ${t(`${tp}.timeout_minutes`)} ${p.timeoutMinutes}`}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {!pub ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title={t(`${tp}.publish`)}
                          onClick={() => setPublishingProfile(p)}
                        >
                          <Globe size={16} />
                        </Button>
                      ) : pub.status === "published" ? (
                        <ActionConfirmingDialog
                          title={t(`${tp}.delist`)}
                          description={t(`${tp}.delist_confirm`)}
                          actionButton={(setOpen) => (
                            <Button
                              variant="destructive"
                              onClick={() => {
                                delistMutation.mutate({ id: pub.id });
                                setOpen(false);
                              }}
                            >
                              {t(`${tp}.delist`)}
                            </Button>
                          )}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title={t(`${tp}.delist`)}
                          >
                            <Archive size={16} />
                          </Button>
                        </ActionConfirmingDialog>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title={t(`${tp}.restore`)}
                          onClick={() => restoreMutation.mutate({ id: pub.id })}
                        >
                          <Undo2 size={16} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => {
                          setEditing(p);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={t("assets.export")}
                        disabled={exportMutation.isPending}
                        onClick={() => exportMutation.mutate({ id: p.id })}
                      >
                        <Download size={16} />
                      </Button>
                      <AssetShareButtons
                        assetType="agentProfile"
                        assetId={p.id}
                      />
                      <ActionConfirmingDialog
                        title={t("actions.delete")}
                        description={t(`${tp}.delete_confirm`)}
                        actionButton={(setOpen) => (
                          <Button
                            variant="destructive"
                            onClick={() => {
                              deleteMutation.mutate({ id: p.id });
                              setOpen(false);
                            }}
                          >
                            {t("actions.delete")}
                          </Button>
                        )}
                      >
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Trash2 size={16} />
                        </Button>
                      </ActionConfirmingDialog>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <PlusCircle className="mr-2 h-4 w-4" />
          {t(`${tp}.create`)}
        </Button>
        <Button
          variant="outline"
          disabled={importMutation.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          {t("assets.import")}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              onImportFile(file);
            }
            e.target.value = "";
          }}
        />
      </div>

      <ProfileFormDialog
        profile={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />

      <PublishDialog
        profile={publishingProfile}
        open={!!publishingProfile}
        onOpenChange={(o) => {
          if (!o) setPublishingProfile(null);
        }}
      />
    </>
  );
}
