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

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTRPC } from "@saiye/shared-react/trpc";

import type { ChatAttachment } from "@/lib/hooks/useChat";

const URL_REGEX = /https?:\/\/[^\s<>()"']+/i;

/** 与后端 sendMessage 的 attachedBookmarkIds 上限一致 */
const MAX_ATTACHMENTS = 5;

export default function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  disabled,
  enableAttach,
}: {
  onSend: (content: string, attached?: ChatAttachment[]) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  /** 咨询会话开启「引用我的笔记」（个人会话由知识注入覆盖，不显示） */
  enableAttach?: boolean;
}) {
  const api = useTRPC();
  const [value, setValue] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachSearch, setAttachSearch] = useState("");
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

  const toggleAttachment = (item: ChatAttachment) => {
    setAttachments((prev) => {
      if (prev.some((a) => a.id === item.id)) {
        return prev.filter((a) => a.id !== item.id);
      }
      if (prev.length >= MAX_ATTACHMENTS) {
        toast({ description: `最多引用 ${MAX_ATTACHMENTS} 条笔记` });
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
      toast({ description: "无法访问麦克风", variant: "destructive" });
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
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setValue("");
    setAttachments([]);
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
          <span className="truncate">检测到链接：{detectedUrl}</span>
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
                  aria-label="移除引用"
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
            引用的笔记内容将随消息一并发送给该专家
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
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
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
                title="引用我的笔记"
              >
                <StickyNote size={18} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              <Input
                autoFocus
                placeholder="搜索我的笔记/书签…"
                value={attachSearch}
                onChange={(e) => setAttachSearch(e.target.value)}
                className="mb-2 h-8"
              />
              <div className="max-h-64 overflow-y-auto">
                {isSearching && (
                  <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" />
                    搜索中…
                  </div>
                )}
                {!isSearching &&
                  (searchResult?.bookmarks.length ?? 0) === 0 && (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                      未找到匹配的笔记
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
                      "未命名条目";
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
        {!isStreaming && (
          <Button
            variant="ghost"
            size="icon"
            onClick={isRecording ? stopRecording : startRecording}
            disabled={disabled || isTranscribing}
            className="shrink-0"
            title={isRecording ? "停止录音" : "语音输入"}
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
