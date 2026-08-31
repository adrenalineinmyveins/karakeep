import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { Send, Square } from "lucide-react-native";

import { Button } from "@/components/ui/Button";

export default function ChatInput({
  onSend,
  onAbort,
  isSending,
  disabled,
}: {
  onSend: (content: string) => void;
  onAbort: () => void;
  isSending: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<TextInput>(null);

  // 发送后清空并失焦键盘
  useEffect(() => {
    if (!value) {
      // 不强制收键盘；用户可能想连续发
    }
  }, [value]);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || isSending || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  return (
    <View
      className="flex-row items-end gap-2 border-t border-border px-3 py-2"
      style={{ paddingBottom: Platform.OS === "ios" ? 4 : 8 }}
    >
      <View className="min-h-[40px] max-h-[160px] flex-1 rounded-2xl border border-input bg-card px-4 py-2">
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={setValue}
          placeholder="输入消息..."
          placeholderTextColor="#999"
          multiline
          editable={!disabled}
          style={{
            minHeight: 24,
            maxHeight: 140,
            padding: 0,
            textAlignVertical: "top",
            color: Platform.OS === "ios" ? undefined : "#000",
          }}
        />
      </View>
      {isSending ? (
        <Button
          variant="destructive"
          size="icon"
          onPress={onAbort}
          accessibilityLabel="取消"
        >
          <Square size={18} color="white" />
        </Button>
      ) : (
        <Button
          variant="primary"
          size="icon"
          onPress={handleSend}
          disabled={disabled || !value.trim()}
          accessibilityLabel="发送"
        >
          <Send size={18} color="white" />
        </Button>
      )}
    </View>
  );
}
