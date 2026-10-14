"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  BadgeCheck,
  Bot,
  Download,
  Globe,
  Hourglass,
  Pencil,
  PlusCircle,
  Trash2,
  Undo2,
  Upload,
  Zap,
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
import type {
  SkillParam,
  SkillToolGrant,
} from "@saiye/shared/types/agentSkills";
import { SKILL_GRANTABLE_TOOLS } from "@saiye/shared/types/agentSkills";
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
  bio: string | null;
  expertiseTags: string[] | null;
  nurtureAuto: boolean;
  nurtureState: { lastRunAt: number; runsCount: number } | null;
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
  /** D2 喂养画像：bio + 专长标签（逗号分隔输入）+ 自动喂养开关 */
  bio: string;
  expertiseTagsInput: string;
  nurtureAuto: boolean;
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
  bio: "",
  expertiseTagsInput: "",
  nurtureAuto: true,
};

/** trae-cli 分支的超时字段（合法整数才带上，否则走后端默认 5 分钟） */
function timeouts(form: ProfileFormState) {
  const minutes = Number.parseInt(form.timeoutMinutes, 10);
  return Number.isFinite(minutes) ? { timeoutMinutes: minutes } : {};
}

/** 档案类型 → i18n 标签 key（hosted = 宿主型个人 Agent） */
const typeLabelKey = {
  "openai-compatible": "settings.agent_profiles.type_openai_compatible",
  "trae-cli": "settings.agent_profiles.type_trae_cli",
  hosted: "settings.agent_profiles.type_hosted",
} as const satisfies Record<AgentProfileType, string>;

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
            bio: profile.bio ?? "",
            expertiseTagsInput: profile.expertiseTags?.join("，") ?? "",
            nurtureAuto: profile.nurtureAuto,
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
    // 语料范围：两者皆空 = null（本人会话全量语料；对外咨询默认私有，D2-c）
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
    // D2 喂养画像（hosted）：bio/tags 手工修改后自动停刷新（nurtureAuto 置 false）
    const bio = form.bio.trim() || null;
    const expertiseTags = form.expertiseTagsInput
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    const nurtureManuallyEdited =
      !!profile &&
      (bio !== (profile.bio ?? null) ||
        expertiseTags.join("，") !== (profile.expertiseTags ?? []).join("，"));
    const nurtureFields = {
      bio,
      expertiseTags,
      nurtureAuto: nurtureManuallyEdited ? false : form.nurtureAuto,
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
        : form.type === "hosted"
          ? { type: "hosted" as const, ...base, ...nurtureFields }
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
                    {t(typeLabelKey[type])}
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

          {form.type === "openai-compatible" && (
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
          )}

          {form.type === "trae-cli" && (
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

          {/* D2 喂养画像（仅 hosted：大脑由平台承担，喂养 worker 定期刷新） */}
          {form.type === "hosted" && (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="profile-bio">{t(`${tp}.nurture_bio`)}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(`${tp}.nurture_bio_hint`)}
                </p>
              </div>
              <Textarea
                id="profile-bio"
                rows={3}
                maxLength={500}
                value={form.bio}
                onChange={(e) => set("bio", e.target.value)}
                placeholder={t(`${tp}.nurture_bio_placeholder`)}
              />
              <div className="grid gap-2">
                <Label htmlFor="profile-expertise-tags">
                  {t(`${tp}.nurture_tags`)}
                </Label>
                <Input
                  id="profile-expertise-tags"
                  value={form.expertiseTagsInput}
                  onChange={(e) => set("expertiseTagsInput", e.target.value)}
                  placeholder={t(`${tp}.nurture_tags_placeholder`)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>{t(`${tp}.nurture_auto`)}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t(`${tp}.nurture_auto_hint`)}
                  </p>
                </div>
                <Switch
                  checked={form.nurtureAuto}
                  onCheckedChange={(v) => set("nurtureAuto", v)}
                />
              </div>
              {profile?.nurtureState?.lastRunAt ? (
                <p className="text-xs text-muted-foreground">
                  {t(`${tp}.nurture_last_run`)}
                  {": "}
                  {new Date(profile.nurtureState.lastRunAt).toLocaleString()}
                </p>
              ) : null}
            </div>
          )}

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

/** list 返回的技能行 */
interface AgentSkillRow {
  id: string;
  name: string;
  description: string;
  promptTemplate: string;
  outputHint: string | null;
  knowledgeScope: KnowledgeScope | null;
  paramsSchema: SkillParam[] | null;
  toolGrant: SkillToolGrant | null;
  enabled: boolean;
  usageCount: number;
}

/** P3 参数编辑行（options 逗号分隔、default 统一文本编辑，提交时按类型转换） */
interface SkillParamFormRow {
  name: string;
  label: string;
  type: SkillParam["type"];
  required: boolean;
  options: string;
  defaultValue: string;
}

const emptyParamRow: SkillParamFormRow = {
  name: "",
  label: "",
  type: "string",
  required: false,
  options: "",
  defaultValue: "",
};

/** 技能表单状态 */
interface SkillFormState {
  name: string;
  description: string;
  promptTemplate: string;
  outputHint: string;
  scopeTagIds: string[];
  scopeListIds: string[];
  params: SkillParamFormRow[];
  grantedTools: string[];
  enabled: boolean;
}

const emptySkillForm: SkillFormState = {
  name: "",
  description: "",
  promptTemplate: "",
  outputHint: "",
  scopeTagIds: [],
  scopeListIds: [],
  params: [],
  grantedTools: [],
  enabled: true,
};

/** 参数编辑行 → 参数定义（default 按 type 转换；enum default 须命中 options） */
function buildSkillParam(
  row: SkillParamFormRow,
): Omit<SkillParam, "default"> & { default?: string | number | boolean } {
  const options =
    row.type === "enum"
      ? row.options
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  let defaultValue: string | number | boolean | undefined;
  const raw = row.defaultValue.trim();
  if (raw) {
    if (row.type === "number") {
      const n = Number(raw);
      if (!Number.isNaN(n)) defaultValue = n;
    } else if (row.type === "boolean") {
      defaultValue = raw === "true" || raw === "是";
    } else if (row.type === "enum") {
      if (options?.includes(raw)) defaultValue = raw;
    } else {
      defaultValue = raw;
    }
  }
  return {
    name: row.name.trim(),
    label: row.label.trim(),
    type: row.type,
    ...(row.required ? { required: true } : {}),
    ...(options ? { options } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
}

/**
 * P1 技能管理对话框：同一 Dialog 内 list ↔ form 两视图切换（避免嵌套 Dialog）。
 * editingSkill === null 显示列表；"new" 或技能行显示表单。
 */
function SkillsDialog({
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

  const [editingSkill, setEditingSkill] = useState<
    AgentSkillRow | "new" | null
  >(null);
  const [form, setForm] = useState<SkillFormState>(emptySkillForm);
  const skillFileInputRef = useRef<HTMLInputElement>(null);

  const skillsQuery = useQuery(
    api.agentSkills.list.queryOptions(
      { profileId: profile?.id ?? "" },
      { enabled: open && !!profile },
    ),
  );

  // 标签/清单（技能语料范围选择用；对话框打开时才拉取）
  const tagsQuery = useQuery({
    ...api.tags.list.queryOptions(),
    enabled: open,
  });
  const listsQuery = useQuery({
    ...api.lists.list.queryOptions(),
    enabled: open,
  });

  // 打开时重置到列表视图
  useEffect(() => {
    if (open) {
      setEditingSkill(null);
    }
  }, [open]);

  // 进入表单视图时初始化
  useEffect(() => {
    if (editingSkill === "new") {
      setForm(emptySkillForm);
    } else if (editingSkill) {
      setForm({
        name: editingSkill.name,
        description: editingSkill.description,
        promptTemplate: editingSkill.promptTemplate,
        outputHint: editingSkill.outputHint ?? "",
        scopeTagIds: editingSkill.knowledgeScope?.tagIds ?? [],
        scopeListIds: editingSkill.knowledgeScope?.listIds ?? [],
        params: (editingSkill.paramsSchema ?? []).map((p) => ({
          name: p.name,
          label: p.label,
          type: p.type,
          required: p.required ?? false,
          options: p.options?.join(", ") ?? "",
          defaultValue: p.default !== undefined ? String(p.default) : "",
        })),
        grantedTools: editingSkill.toolGrant?.tools ?? [],
        enabled: editingSkill.enabled,
      });
    }
  }, [editingSkill]);

  const invalidateSkills = () =>
    queryClient.invalidateQueries(api.agentSkills.list.pathFilter());

  const createMutation = useMutation(
    api.agentSkills.create.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${tp}.skill_has_been_created`));
        invalidateSkills();
        setEditingSkill(null);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const updateMutation = useMutation(
    api.agentSkills.update.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${tp}.skill_has_been_updated`));
        invalidateSkills();
        setEditingSkill(null);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const deleteMutation = useMutation(
    api.agentSkills.delete.mutationOptions({
      onSuccess: () => invalidateSkills(),
      onError: (e) => toast.error(e.message),
    }),
  );

  // P2 导出：脱敏 JSON 下载（scope 以名称迁移）
  const exportMutation = useMutation(
    api.agentSkills.exportSkill.mutationOptions({
      onSuccess: ({ asset }, variables) => {
        const skill = skillsQuery.data?.skills.find(
          (s) => s.id === variables.id,
        );
        downloadJsonFile(
          `saiye-agentSkill-${safeFilenamePart(skill?.name ?? variables.id)}.json`,
          asset,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  // P2 导入：挂到当前档案；scope 按名称重匹配
  const importMutation = useMutation(
    api.agentSkills.importSkill.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${tp}.skill_has_been_imported`));
        invalidateSkills();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const onSkillImportFile = async (file: File) => {
    try {
      const asset = await readJsonFile(file);
      importMutation.mutate({ profileId: profile!.id, asset: asset as never });
    } catch {
      toast.error(t("assets.invalid_file"));
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    // scope 两者皆空 → null（不收窄）
    const scope =
      form.scopeTagIds.length > 0 || form.scopeListIds.length > 0
        ? { tagIds: form.scopeTagIds, listIds: form.scopeListIds }
        : null;
    // P3 参数定义：空行丢弃；enum 必须给出选项；name 不可重复
    const params = form.params.map(buildSkillParam).filter((p) => p.name);
    for (const p of params) {
      if (!p.label) {
        toast.error(t(`${tp}.skill_param_missing_label`, { name: p.name }));
        return;
      }
      if (p.type === "enum" && (p.options?.length ?? 0) === 0) {
        toast.error(
          t(`${tp}.skill_param_enum_requires_options`, { name: p.name }),
        );
        return;
      }
    }
    if (new Set(params.map((p) => p.name)).size !== params.length) {
      toast.error(t(`${tp}.skill_param_duplicate_name`));
      return;
    }
    const base = {
      name: form.name.trim(),
      description: form.description.trim(),
      promptTemplate: form.promptTemplate.trim(),
      outputHint: form.outputHint.trim() || null,
      knowledgeScope: scope,
      paramsSchema: params.length > 0 ? params : null,
      // P4 工具授权：勾选白名单工具（服务端 zod 再校验）
      toolGrant:
        form.grantedTools.length > 0
          ? {
              tools: form.grantedTools.filter((t) =>
                (SKILL_GRANTABLE_TOOLS as readonly string[]).includes(t),
              ) as SkillToolGrant["tools"],
              confirmRequired: true,
            }
          : null,
      enabled: form.enabled,
    };
    if (editingSkill === "new") {
      createMutation.mutate({ ...base, profileId: profile.id });
    } else if (editingSkill) {
      updateMutation.mutate({ ...base, id: editingSkill.id });
    }
  };

  const isFormView = editingSkill !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isFormView
              ? editingSkill === "new"
                ? t(`${tp}.skill_create`)
                : t(`${tp}.skill_edit`)
              : `${t(`${tp}.skills`)} · ${profile?.name ?? ""}`}
          </DialogTitle>
        </DialogHeader>

        {!isFormView ? (
          /* ── 列表视图 ── */
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t(`${tp}.skills_hint`)}
            </p>
            {(skillsQuery.data?.skills.length ?? 0) === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t(`${tp}.skill_empty`)}
              </p>
            ) : (
              <div className="space-y-2">
                {skillsQuery.data?.skills.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 rounded-lg border p-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        <span className="truncate">{s.name}</span>
                        {s.usageCount > 0 && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 px-1.5 text-[10px]"
                            title={t(`${tp}.skill_usage_count_hint`)}
                          >
                            {s.usageCount}
                          </Badge>
                        )}
                      </p>
                      <p
                        className="truncate text-xs text-muted-foreground"
                        title={s.description}
                      >
                        {s.description}
                      </p>
                    </div>
                    <Switch
                      checked={s.enabled}
                      disabled={updateMutation.isPending}
                      onCheckedChange={(v) =>
                        updateMutation.mutate({
                          id: s.id,
                          name: s.name,
                          description: s.description,
                          promptTemplate: s.promptTemplate,
                          outputHint: s.outputHint,
                          knowledgeScope: s.knowledgeScope,
                          paramsSchema: s.paramsSchema,
                          toolGrant: s.toolGrant,
                          enabled: v,
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      title={t(`${tp}.skill_export`)}
                      disabled={exportMutation.isPending}
                      onClick={() => exportMutation.mutate({ id: s.id })}
                    >
                      <Download size={16} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      title={t("actions.edit")}
                      onClick={() => setEditingSkill(s)}
                    >
                      <Pencil size={16} />
                    </Button>
                    <ActionConfirmingDialog
                      title={t("actions.delete")}
                      description={t(`${tp}.skill_delete_confirm`)}
                      actionButton={(setOpen) => (
                        <Button
                          variant="destructive"
                          onClick={() => {
                            deleteMutation.mutate({ id: s.id });
                            setOpen(false);
                          }}
                        >
                          {t("actions.delete")}
                        </Button>
                      )}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                      >
                        <Trash2 size={16} />
                      </Button>
                    </ActionConfirmingDialog>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={() => setEditingSkill("new")}>
                <PlusCircle className="mr-2 h-4 w-4" />
                {t(`${tp}.skill_create`)}
              </Button>
              <Button
                variant="outline"
                disabled={importMutation.isPending}
                onClick={() => skillFileInputRef.current?.click()}
              >
                <Upload className="mr-2 h-4 w-4" />
                {t(`${tp}.skill_import`)}
              </Button>
              <input
                ref={skillFileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void onSkillImportFile(file);
                  }
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        ) : (
          /* ── 表单视图 ── */
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="skill-name">{t(`${tp}.skill_name`)}</Label>
              <Input
                id="skill-name"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                required
                maxLength={100}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="skill-description">
                {t(`${tp}.skill_description`)}
              </Label>
              <Input
                id="skill-description"
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                required
                maxLength={500}
              />
              <p className="text-xs text-muted-foreground">
                {t(`${tp}.skill_description_hint`)}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="skill-template">
                {t(`${tp}.skill_template`)}
              </Label>
              <Textarea
                id="skill-template"
                rows={6}
                value={form.promptTemplate}
                onChange={(e) =>
                  setForm((f) => ({ ...f, promptTemplate: e.target.value }))
                }
                required
                maxLength={4000}
              />
              <p className="text-xs text-muted-foreground">
                {t(`${tp}.skill_template_hint`)}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="skill-output-hint">
                {t(`${tp}.skill_output_hint`)}
              </Label>
              <Input
                id="skill-output-hint"
                value={form.outputHint}
                onChange={(e) =>
                  setForm((f) => ({ ...f, outputHint: e.target.value }))
                }
                maxLength={500}
              />
              <p className="text-xs text-muted-foreground">
                {t(`${tp}.skill_output_hint_hint`)}
              </p>
            </div>
            {/* P2 技能级语料范围：点选该技能的当轮与档案范围取交集 */}
            <div className="space-y-2 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t(`${tp}.knowledge_scope`)}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(`${tp}.skill_scope_hint`)}
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
                          setForm((f) => ({
                            ...f,
                            scopeTagIds: f.scopeTagIds.includes(tag.id)
                              ? f.scopeTagIds.filter((id) => id !== tag.id)
                              : [...f.scopeTagIds, tag.id],
                          }))
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
                          setForm((f) => ({
                            ...f,
                            scopeListIds: f.scopeListIds.includes(list.id)
                              ? f.scopeListIds.filter((id) => id !== list.id)
                              : [...f.scopeListIds, list.id],
                          }))
                        }
                      >
                        {list.name}
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
            {/* P3 参数定义：模板 {{参数名}} 占位，咨询者点选技能时填写 */}
            <div className="space-y-2 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t(`${tp}.skill_params`)}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(`${tp}.skill_params_hint`)}
                </p>
              </div>
              {form.params.map((row, idx) => (
                <div key={idx} className="space-y-1.5 rounded-md border p-2">
                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder={t(`${tp}.skill_param_name`)}
                      value={row.name}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          params: f.params.map((r, i) =>
                            i === idx ? { ...r, name: e.target.value } : r,
                          ),
                        }))
                      }
                      maxLength={50}
                      className="h-8"
                    />
                    <Input
                      placeholder={t(`${tp}.skill_param_label`)}
                      value={row.label}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          params: f.params.map((r, i) =>
                            i === idx ? { ...r, label: e.target.value } : r,
                          ),
                        }))
                      }
                      maxLength={100}
                      className="h-8"
                    />
                    <Select
                      value={row.type}
                      onValueChange={(v) =>
                        setForm((f) => ({
                          ...f,
                          params: f.params.map((r, i) =>
                            i === idx
                              ? { ...r, type: v as SkillParam["type"] }
                              : r,
                          ),
                        }))
                      }
                    >
                      <SelectTrigger className="h-8 w-24 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="string">string</SelectItem>
                        <SelectItem value="number">number</SelectItem>
                        <SelectItem value="boolean">boolean</SelectItem>
                        <SelectItem value="enum">enum</SelectItem>
                      </SelectContent>
                    </Select>
                    <label
                      className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground"
                      title={t(`${tp}.skill_param_required`)}
                    >
                      <Switch
                        checked={row.required}
                        onCheckedChange={(v) =>
                          setForm((f) => ({
                            ...f,
                            params: f.params.map((r, i) =>
                              i === idx ? { ...r, required: v } : r,
                            ),
                          }))
                        }
                      />
                      {t(`${tp}.skill_param_required`)}
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          params: f.params.filter((_, i) => i !== idx),
                        }))
                      }
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {row.type === "enum" && (
                      <Input
                        placeholder={t(`${tp}.skill_param_options`)}
                        value={row.options}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            params: f.params.map((r, i) =>
                              i === idx ? { ...r, options: e.target.value } : r,
                            ),
                          }))
                        }
                        className="h-8 flex-1"
                      />
                    )}
                    <Input
                      placeholder={t(`${tp}.skill_param_default`)}
                      value={row.defaultValue}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          params: f.params.map((r, i) =>
                            i === idx
                              ? { ...r, defaultValue: e.target.value }
                              : r,
                          ),
                        }))
                      }
                      className="h-8 flex-1"
                    />
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={form.params.length >= 10}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    params: [...f.params, emptyParamRow],
                  }))
                }
              >
                <PlusCircle className="mr-1 h-3.5 w-3.5" />
                {t(`${tp}.skill_param_add`)}
              </Button>
            </div>
            {/* P4 工具授权：白名单工具勾选，点选技能的当轮临时解锁 */}
            <div className="space-y-2 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t(`${tp}.skill_tools`)}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(`${tp}.skill_tools_hint`)}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SKILL_GRANTABLE_TOOLS.map((tool) => (
                  <Badge
                    key={tool}
                    variant={
                      form.grantedTools.includes(tool) ? "default" : "outline"
                    }
                    className="cursor-pointer select-none"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        grantedTools: f.grantedTools.includes(tool)
                          ? f.grantedTools.filter((t) => t !== tool)
                          : [...f.grantedTools, tool],
                      }))
                    }
                  >
                    {t(`${tp}.skill_tool_${tool}`)}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label>{t(`${tp}.skill_enabled`)}</Label>
                <p className="text-xs text-muted-foreground">
                  {t(`${tp}.skill_enabled_hint`)}
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditingSkill(null)}
              >
                {t(`${tp}.skill_back`)}
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {t("actions.save")}
              </Button>
            </DialogFooter>
          </form>
        )}
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
  const [skillsProfile, setSkillsProfile] = useState<AgentProfileRow | null>(
    null,
  );
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
                    <span className="flex items-center gap-1.5">
                      {t(typeLabelKey[p.type])}
                      {p.type === "hosted" && (
                        <span
                          className="flex items-center rounded-full bg-primary/10 px-1.5 py-0.5"
                          title={t(`${tp}.type_hosted`)}
                        >
                          <Bot className="size-3.5 text-primary" />
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {p.type === "openai-compatible"
                      ? `${p.model ?? ""} · ${p.baseUrl ?? ""}`
                      : p.type === "trae-cli"
                        ? `${p.command ?? ""} · ${t(`${tp}.timeout_minutes`)} ${p.timeoutMinutes}`
                        : "—"}
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
                        title={t(`${tp}.skills`)}
                        onClick={() => setSkillsProfile(p)}
                      >
                        <Zap size={16} />
                      </Button>
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

      <SkillsDialog
        profile={skillsProfile}
        open={!!skillsProfile}
        onOpenChange={(o) => {
          if (!o) setSkillsProfile(null);
        }}
      />
    </>
  );
}
