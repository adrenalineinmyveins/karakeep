"use client";

import { Link2, Loader2, Mic, Send, Square } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";

import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@saiye/shared-react/trpc";

const URL_REGEX = /https?:\/\/[^\s<>()"']+/i;

export default function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  disabled,
}: {
  onSend: (content: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}) {
  const api = useTRPC();
  const [value, setValue] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const detectedUrl = URL_REGEX.exec(value)?.[0];

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
    onSend(trimmed);
    setValue("");
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
          className="min-h-[40px] max-h-[200px] resize-none"
          rows={1}
        />
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
