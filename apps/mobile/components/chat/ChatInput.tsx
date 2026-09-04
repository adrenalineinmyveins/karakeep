import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { Loader2, Mic, Send, Square } from "lucide-react-native";
import { useMutation } from "@tanstack/react-query";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { useTRPC } from "@saiye/shared-react/trpc";
import { toast } from "sonner-native";

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
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const api = useTRPC();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const { mutate: transcribe } = useMutation(
    api.chats.transcribeAudio.mutationOptions({
      onSuccess: (resp) => {
        setValue((prev) => (prev ? `${prev} ${resp.text}` : resp.text));
      },
      onError: (e) => {
        toast.error(e.message);
      },
      onSettled: () => setIsTranscribing(false),
    }),
  );

  const startRecording = async () => {
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        toast.error("麦克风权限被拒绝");
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      recorder.record();
      setIsRecording(true);
    } catch {
      toast.error("无法开始录音");
    }
  };

  const stopRecording = async () => {
    setIsRecording(false);
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) return;
      setIsTranscribing(true);
      const resp = await fetch(uri);
      const blob = await resp.blob();
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1]!;
        transcribe({
          audioBase64: base64,
          contentType: uri.endsWith(".webm") ? "audio/webm" : "audio/mp4",
        });
      };
      reader.readAsDataURL(blob);
    } catch {
      setIsTranscribing(false);
      toast.error("录音处理失败");
    }
  };

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
      <View className="max-h-[160px] min-h-[40px] flex-1 rounded-2xl border border-input bg-card px-4 py-2">
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
        <>
          <Button
            variant="secondary"
            size="icon"
            onPress={isRecording ? stopRecording : startRecording}
            disabled={disabled || isTranscribing}
            accessibilityLabel={isRecording ? "停止录音" : "语音输入"}
          >
            {isRecording ? (
              <Square size={18} color="#ef4444" />
            ) : isTranscribing ? (
              <Loader2 size={18} color="#999" />
            ) : (
              <Mic size={18} />
            )}
          </Button>
          <Button
            variant="primary"
            size="icon"
            onPress={handleSend}
            disabled={disabled || isTranscribing || !value.trim()}
            accessibilityLabel="发送"
          >
            <Send size={18} color="white" />
          </Button>
        </>
      )}
    </View>
  );
}
