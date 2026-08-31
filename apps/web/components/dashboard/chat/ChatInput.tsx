"use client";

import { Send, Square } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    <div className="flex items-end gap-2 border-t p-4">
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
  );
}
