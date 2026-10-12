"use client";

import {
  Check,
  Link2,
  Loader2,
  Mic,
  Send,
  Square,
  StickyNote,
  X,
  Zap,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n/client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTRPC } from "@saiye/shared-react/trpc";
import type {
  SkillParam,
  SkillToolGrant,
} from "@saiye/shared/types/agentSkills";

import type { ChatAttachment, ChatSkillInfo } from "@/lib/hooks/useChat";

const URL_REGEX = /https?:\/\/[^\s<>()"']+/i;

/** 与后端 sendMessage 的 attachedBookmarkIds 上限一致 */
const MAX_ATTACHMENTS = 5;

export default function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  disabled,
  enableAttach,
  enableSkills,
  publicationId,
}: {
  onSend: (
    content: string,
    attached?: ChatAttachment[],
    skill?: ChatSkillInfo,
  ) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  /** 咨询会话开启「引用我的笔记」（个人会话由知识注入覆盖，不显示） */
  enableAttach?: boolean;
  /** 咨询会话开启「点选专家技能」（P1 提示词模板型） */
  enableSkills?: boolean;
  /** 咨询会话绑定的发布 id（技能清单按发布加载） */
  publicationId?: string | null;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachSearch, setAttachSearch] = useState("");
  const [skill, setSkill] = useState<ChatSkillInfo | null>(null);
  const [skillOpen, setSkillOpen] = useState(false);
  // P3 带参技能 / P4 带工具技能：正在填写参数/确认授权的技能
  // （Popover 切换到表单视图；paramsSchema 为空数组 = 仅工具授权）
  const [paramSkill, setParamSkill] = useState<{
    id: string;
    name: string;
    paramsSchema: SkillParam[];
    toolGrant: SkillToolGrant | null;
  } | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const detectedUrl = URL_REGEX.exec(value)?.[0];

  // 引用笔记搜索（fts 全文，走用户自己的搜索索引）
  const { data: searchResult, isFetching: isSearching } = useQuery(
    api.bookmarks.searchBookmarks.queryOptions(
      { text: attachSearch, limit: 10 },
      { enabled: enableAttach && attachOpen },
    ),
  );

  // 专家技能清单（按发布加载，随发布状态联动）
  const { data: skillResult, isFetching: isFetchingSkills } = useQuery(
    api.agentSkills.listForConsultation.queryOptions(
      { publicationId: publicationId! },
      { enabled: enableSkills && !!publicationId && skillOpen },
    ),
  );

  // P3/P4 点选技能：无参无工具直接选中（P1 行为）；
  // 带参进填参表单；带工具进授权确认（confirmRequired）
  const onSelectSkill = (s: {
    id: string;
    name: string;
    paramsSchema: SkillParam[] | null;
    toolGrant: SkillToolGrant | null;
  }) => {
    const selected = skill?.id === s.id;
    if (selected) {
      setSkill(null);
      return;
    }
    const hasParams = !!s.paramsSchema && s.paramsSchema.length > 0;
    const needsGrant = !!s.toolGrant && s.toolGrant.tools.length > 0;
    if (hasParams || needsGrant) {
      if (hasParams) {
        const initial: Record<string, string> = {};
        for (const p of s.paramsSchema!) {
          if (p.default !== undefined) {
            initial[p.name] = String(p.default);
          } else if (p.type === "boolean") {
            initial[p.name] = "false";
          } else {
            initial[p.name] = "";
          }
        }
        setParamValues(initial);
      }
      setParamSkill({
        id: s.id,
        name: s.name,
        paramsSchema: hasParams ? s.paramsSchema! : [],
        toolGrant: s.toolGrant,
      });
    } else {
      setSkill({ id: s.id, name: s.name });
      setSkillOpen(false);
    }
  };

  // P3 应用参数 / P4 确认授权：前端 required 预检（服务端仍会校验）；
  // 点击「授权并使用」即视为对该轮白名单工具的一次性授权
  const onApplyParams = () => {
    if (!paramSkill) return;
    const params: Record<string, string | number | boolean> = {};
    for (const p of paramSkill.paramsSchema) {
      const raw = paramValues[p.name];
      if (raw === undefined || raw === "") continue;
      if (p.type === "number") {
        params[p.name] = Number(raw);
      } else if (p.type === "boolean") {
        params[p.name] = raw === "true";
      } else {
        params[p.name] = raw;
      }
    }
    for (const p of paramSkill.paramsSchema) {
      if (
        p.required &&
        params[p.name] === undefined &&
        p.default === undefined
      ) {
        toast({
          description: t("chat.param_required_toast", { label: p.label }),
        });
        return;
      }
    }
    setSkill({
      id: paramSkill.id,
      name: paramSkill.name,
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(paramSkill.toolGrant ? { tools: paramSkill.toolGrant.tools } : {}),
    });
    setParamSkill(null);
    setSkillOpen(false);
  };

  const toggleAttachment = (item: ChatAttachment) => {
    setAttachments((prev) => {
      if (prev.some((a) => a.id === item.id)) {
        return prev.filter((a) => a.id !== item.id);
      }
      if (prev.length >= MAX_ATTACHMENTS) {
        toast({
          description: t("chat.max_attachments_toast", {
            count: MAX_ATTACHMENTS,
          }),
        });
        return prev;
      }
      return [...prev, item];
    });
  };

  const { mutate: transcribe, isPending: isTranscribing } = useMutation(
    api.chats.transcribeAudio.mutationOptions({
      onSuccess: (resp) => {
        setValue((prev) => (prev ? `${prev} ${resp.text}` : resp.text));
      },
      onError: (e) => {
        toast({ description: e.message, variant: "destructive" });
      },
    }),
  );

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0) {
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1]!;
          transcribe({ audioBase64: base64, contentType: mimeType });
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch {
      toast({
        description: t("chat.mic_unavailable_toast"),
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setIsRecording(false);
  };

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) return;
    onSend(
      trimmed,
      attachments.length > 0 ? attachments : undefined,
      skill ?? undefined,
    );
    setValue("");
    setAttachments([]);
    setSkill(null);
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t p-4">
      {detectedUrl && (
        <div
          className="mb-2 flex items-center gap-1 truncate text-xs text-muted-foreground"
          title={detectedUrl}
        >
          <Link2 size={12} className="shrink-0" />
          <span className="truncate">
            {t("chat.link_detected", { url: detectedUrl })}
          </span>
        </div>
      )}
      {/* 已引用的笔记 chips + 隐私提示（仅咨询会话） */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
                title={a.title}
              >
                <StickyNote size={12} className="shrink-0" />
                <span className="truncate">{a.title}</span>
                <button
                  type="button"
                  aria-label={t("chat.remove_attachment")}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id))
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("chat.attachment_privacy_hint")}
          </p>
        </div>
      )}
      {/* 已点选的专家技能 chip + 说明（仅咨询会话） */}
      {skill && (
        <div className="mb-2 flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5">
            <span
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary"
              title={[
                skill.name,
                ...(skill.params
                  ? Object.entries(skill.params).map(([k, v]) => `${k} = ${v}`)
                  : []),
                ...(skill.tools
                  ? [
                      t("chat.authorized_tools_title", {
                        tools: skill.tools.join(", "),
                      }),
                    ]
                  : []),
              ].join("\n")}
            >
              <Zap size={12} className="shrink-0" />
              <span className="truncate">
                {skill.name}
                {skill.params
                  ? ` · ${Object.entries(skill.params)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" ")}`
                  : ""}
              </span>
              {skill.tools && skill.tools.length > 0 && (
                <span className="shrink-0 text-amber-600 dark:text-amber-400">
                  · {t("chat.granted_tools_badge")}
                </span>
              )}
              <button
                type="button"
                aria-label={t("chat.remove_skill")}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setSkill(null)}
              >
                <X size={12} />
              </button>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {skill.tools && skill.tools.length > 0
              ? t("chat.skill_tools_hint")
              : t("chat.skill_hint")}
          </p>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            // 自动调整高度
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("chat.input_placeholder")}
          disabled={disabled}
          className="max-h-[200px] min-h-[40px] resize-none"
          rows={1}
        />
        {!isStreaming && enableAttach && (
          <Popover open={attachOpen} onOpenChange={setAttachOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={disabled}
                className="shrink-0"
                title={t("chat.attach_notes_title")}
              >
                <StickyNote size={18} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              <Input
                autoFocus
                placeholder={t("chat.attach_search_placeholder")}
                value={attachSearch}
                onChange={(e) => setAttachSearch(e.target.value)}
                className="mb-2 h-8"
              />
              <div className="max-h-64 overflow-y-auto">
                {isSearching && (
                  <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" />
                    {t("chat.searching")}
                  </div>
                )}
                {!isSearching &&
                  (searchResult?.bookmarks.length ?? 0) === 0 && (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                      {t("chat.no_notes_found")}
                    </p>
                  )}
                {!isSearching &&
                  searchResult?.bookmarks.map((b) => {
                    const title =
                      b.title ??
                      b.summary ??
                      (b.content.type === "text"
                        ? b.content.text.slice(0, 40)
                        : null) ??
                      t("common.untitled");
                    const selected = attachments.some((a) => a.id === b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        title={title}
                        onClick={() => toggleAttachment({ id: b.id, title })}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/40"
                          }`}
                        >
                          {selected && <Check size={12} />}
                        </span>
                        <span className="truncate">{title}</span>
                      </button>
                    );
                  })}
              </div>
            </PopoverContent>
          </Popover>
        )}
        {!isStreaming && enableSkills && !!publicationId && (
          <Popover
            open={skillOpen}
            onOpenChange={(open) => {
              setSkillOpen(open);
              // 关闭时丢弃未应用的参数草稿
              if (!open) {
                setParamSkill(null);
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={disabled}
                className="shrink-0"
                title={t("chat.select_skill_title")}
              >
                <Zap size={18} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              {paramSkill ? (
                /* ── P3 参数表单 / P4 工具授权视图 ── */
                <div className="space-y-2">
                  <p className="px-1 pb-1 text-xs font-medium">
                    {paramSkill.name} ·{" "}
                    {paramSkill.paramsSchema.length > 0
                      ? t("chat.fill_params")
                      : t("chat.tool_grant")}
                  </p>
                  {paramSkill.paramsSchema.map((p) => (
                    <div key={p.name} className="grid gap-1 px-1">
                      <label
                        htmlFor={`skill-param-${p.name}`}
                        className="text-xs text-muted-foreground"
                      >
                        {p.label}
                        {p.required ? " *" : ""}
                      </label>
                      {p.type === "boolean" ? (
                        <label className="flex h-9 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={paramValues[p.name] === "true"}
                            onChange={(e) =>
                              setParamValues((v) => ({
                                ...v,
                                [p.name]: e.target.checked ? "true" : "false",
                              }))
                            }
                          />
                          {t("chat.enable")}
                        </label>
                      ) : p.type === "enum" ? (
                        <select
                          id={`skill-param-${p.name}`}
                          value={paramValues[p.name] ?? ""}
                          onChange={(e) =>
                            setParamValues((v) => ({
                              ...v,
                              [p.name]: e.target.value,
                            }))
                          }
                          className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                        >
                          <option value="">{t("chat.not_selected")}</option>
                          {p.options?.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id={`skill-param-${p.name}`}
                          type={p.type === "number" ? "number" : "text"}
                          value={paramValues[p.name] ?? ""}
                          onChange={(e) =>
                            setParamValues((v) => ({
                              ...v,
                              [p.name]: e.target.value,
                            }))
                          }
                          className="h-9"
                        />
                      )}
                    </div>
                  ))}
                  {paramSkill.toolGrant &&
                    paramSkill.toolGrant.tools.length > 0 && (
                      <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                        <p className="font-medium">
                          {t("chat.skill_will_use_tools", {
                            tools: paramSkill.toolGrant.tools
                              .map((tool) =>
                                tool === "save_widget"
                                  ? t("chat.tool_save_widget")
                                  : t("chat.tool_modify_widget"),
                              )
                              .join(t("chat.tools_separator")),
                          })}
                        </p>
                        <p>{t("chat.grant_artifact_hint")}</p>
                      </div>
                    )}
                  <div className="flex gap-2 px-1 pt-1">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={onApplyParams}
                    >
                      {paramSkill.toolGrant
                        ? t("chat.grant_and_use")
                        : t("chat.apply_skill")}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setParamSkill(null)}
                    >
                      {t("actions.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                /* ── 技能清单视图 ── */
                <>
                  <p className="px-1 pb-2 text-xs font-medium">
                    {t("chat.skills_list_title")}
                  </p>
                  <div className="max-h-64 overflow-y-auto">
                    {isFetchingSkills && (
                      <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
                        <Loader2 size={14} className="animate-spin" />
                        {t("chat.loading")}
                      </div>
                    )}
                    {!isFetchingSkills &&
                      (skillResult?.skills.length ?? 0) === 0 && (
                        <p className="py-4 text-center text-xs text-muted-foreground">
                          {t("chat.no_skills")}
                        </p>
                      )}
                    {!isFetchingSkills &&
                      skillResult?.skills.map((s) => {
                        const selected = skill?.id === s.id;
                        const hasParams = (s.paramsSchema?.length ?? 0) > 0;
                        const hasTools = (s.toolGrant?.tools.length ?? 0) > 0;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                            title={s.description}
                            onClick={() => onSelectSkill(s)}
                          >
                            <span className="flex w-full items-center gap-2">
                              <span
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                  selected
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-muted-foreground/40"
                                }`}
                              >
                                {selected && <Check size={12} />}
                              </span>
                              <span className="truncate font-medium">
                                {s.name}
                              </span>
                              {hasParams && (
                                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                  {t("chat.params_badge")}
                                </span>
                              )}
                              {hasTools && (
                                <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400">
                                  {t("chat.tools_badge")}
                                </span>
                              )}
                            </span>
                            <span className="truncate pl-6 text-xs text-muted-foreground">
                              {s.description}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </>
              )}
            </PopoverContent>
          </Popover>
        )}
        {!isStreaming && (
          <Button
            variant="ghost"
            size="icon"
            onClick={isRecording ? stopRecording : startRecording}
            disabled={disabled || isTranscribing}
            className="shrink-0"
            title={
              isRecording ? t("chat.stop_recording") : t("chat.voice_input")
            }
          >
            {isRecording ? (
              <Square size={18} className="text-red-500" />
            ) : isTranscribing ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Mic size={18} />
            )}
          </Button>
        )}
        {isStreaming ? (
          <Button
            variant="destructive"
            size="icon"
            onClick={onAbort}
            className="shrink-0"
          >
            <Square size={18} />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            className="shrink-0"
          >
            <Send size={18} />
          </Button>
        )}
      </div>
    </div>
  );
}
