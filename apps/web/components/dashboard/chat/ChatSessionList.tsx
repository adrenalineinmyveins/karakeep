"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { cn } from "@/lib/utils";

export default function ChatSessionList({
  currentSessionId,
  onSelect,
}: {
  currentSessionId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const { data: sessions, isLoading } = useQuery(
    api.chats.listSessions.queryOptions(),
  );

  const createSession = useMutation(
    api.chats.createSession.mutationOptions({
      onSuccess: (session) => {
        queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
        onSelect(session.id);
      },
    }),
  );

  const deleteSession = useMutation(
    api.chats.deleteSession.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(api.chats.listSessions.pathFilter());
      },
    }),
  );

  return (
    <div className="flex w-64 shrink-0 flex-col border-r">
      <div className="flex items-center justify-between p-3">
        <span className="text-sm font-medium">对话</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => createSession.mutate({})}
          disabled={createSession.isPending}
        >
          <Plus size={16} />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : sessions && sessions.length > 0 ? (
          <ul className="space-y-0.5 px-2">
            {sessions.map((session) => (
              <li key={session.id}>
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                    session.id === currentSessionId
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50",
                  )}
                >
                  <button
                    className="flex-1 truncate text-left"
                    onClick={() => onSelect(session.id)}
                  >
                    {session.title}
                  </button>
                  <button
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() =>
                      deleteSession.mutate({ sessionId: session.id })
                    }
                  >
                    <Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            暂无对话
          </div>
        )}
      </div>
    </div>
  );
}
