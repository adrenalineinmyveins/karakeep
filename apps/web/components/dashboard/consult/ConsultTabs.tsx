"use client";

import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Bot, Megaphone } from "lucide-react";
import { useInView } from "react-intersection-observer";
import { useEffect } from "react";

import { useTRPC } from "@saiye/shared-react/trpc";

import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslation } from "@/lib/i18n/client";

import ConsultGrid from "./ConsultGrid";

/**
 * D6 动态流：agentPublications（技能）+ agentPosts（动态）混排，
 * 曝光去重（连续刷新不重复）；条目可跳转对应专家卡片。
 */
function AgentFeed({
  onJumpToPublication,
}: {
  onJumpToPublication: (id: string) => void;
}) {
  const api = useTRPC();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [publicationId, setPublicationId] = useState("none");
  const [content, setContent] = useState("");

  // 发动态所需的：我的档案 + 我的发布（可关联）
  const profilesQuery = useQuery(api.agentProfiles.list.queryOptions());
  const myPubsQuery = useQuery(api.agentPublications.list.queryOptions());

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } =
    useInfiniteQuery(
      api.agentFeed.feed.infiniteQueryOptions(
        {},
        {
          initialCursor: null,
          getNextPageParam: (lastPage) => lastPage.nextCursor,
        },
      ),
    );

  const { ref: loadMoreRef, inView } = useInView();
  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView]);

  const createPost = useMutation(
    api.agentFeed.createPost.mutationOptions({
      onSuccess: () => {
        setComposing(false);
        setContent("");
        toast({ description: t("consult.feed_posted") });
        queryClient.invalidateQueries(api.agentFeed.feed.pathFilter());
      },
      onError: (e) => toast({ description: e.message, variant: "destructive" }),
    }),
  );

  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const myProfiles = (profilesQuery.data?.profiles ?? []).filter(
    (p) => p.type === "hosted",
  );
  const myPubs = myPubsQuery.data?.publications ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t("consult.feed_hint")}
        </p>
        <ActionButton
          ignoreDemoMode={true}
          loading={false}
          onClick={() => setComposing(true)}
          variant="outline"
        >
          <Megaphone className="mr-2 size-4" />
          {t("consult.feed_compose")}
        </ActionButton>
      </div>

      {isPending && <Skeleton className="h-24 w-full" />}
      {!isPending && items.length === 0 && (
        <p className="rounded-md bg-muted p-4 text-sm text-muted-foreground">
          {t("consult.feed_empty")}
        </p>
      )}
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <div
            key={`${item.itemType}-${item.itemId}`}
            className="flex flex-col gap-2 rounded-lg border bg-card p-4 shadow-sm"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                {item.itemType === "publication" ? (
                  <Megaphone className="size-3.5" />
                ) : (
                  <Bot className="size-3.5" />
                )}
                {t(
                  item.itemType === "publication"
                    ? "consult.feed_type_publication"
                    : "consult.feed_type_post",
                )}
              </span>
              {item.isOwn && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                  {t("consult.yours_badge")}
                </span>
              )}
              <span className="ml-auto">{item.createdAt.toLocaleString()}</span>
            </div>
            <div className="break-all text-base font-semibold">
              {item.title}
            </div>
            <div className="text-sm text-muted-foreground">
              {t("consult.by_owner", { name: item.ownerName })}
            </div>
            {item.content && (
              <p className="whitespace-pre-wrap text-sm text-foreground/80">
                {item.content}
              </p>
            )}
            {item.bio && (
              <p className="line-clamp-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                {item.bio}
              </p>
            )}
            {item.expertiseTags && item.expertiseTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.expertiseTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {item.publicationId && (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => onJumpToPublication(item.publicationId!)}
              >
                {t("consult.feed_view_expert")}
              </Button>
            )}
          </div>
        ))}
      </div>
      {hasNextPage && (
        <div className="flex justify-center">
          <ActionButton
            ref={loadMoreRef}
            ignoreDemoMode={true}
            loading={isFetchingNextPage}
            onClick={() => fetchNextPage()}
            variant="ghost"
          >
            {t("actions.load_more")}
          </ActionButton>
        </div>
      )}

      {/* 发动态：选档案 + 可选关联自己的发布 */}
      <Dialog open={composing} onOpenChange={setComposing}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("consult.feed_compose")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!profileId || !content.trim()) return;
              createPost.mutate({
                profileId,
                content: content.trim(),
                ...(publicationId !== "none" ? { publicationId } : {}),
              });
            }}
            className="flex flex-col gap-4"
          >
            <div className="grid gap-2">
              <Label>{t("consult.feed_select_profile")}</Label>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("consult.feed_select_profile_placeholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {myProfiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {myPubs.length > 0 && (
              <div className="grid gap-2">
                <Label>{t("consult.feed_link_publication")}</Label>
                <Select value={publicationId} onValueChange={setPublicationId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("consult.feed_no_link")}
                    </SelectItem>
                    {myPubs.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="feed-content">{t("consult.feed_content")}</Label>
              <Textarea
                id="feed-content"
                rows={4}
                maxLength={2000}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setComposing(false)}
              >
                {t("actions.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!profileId || !content.trim() || createPost.isPending}
              >
                {t("actions.publish")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 咨询页双 Tab：专家广场（ConsultGrid）+ 动态流（D6 Feed） */
export default function ConsultTabs() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("square");
  // D6 验收：Feed 条目可跳转对应 Agent 卡片（切回广场并滚动高亮）
  const [highlightId, setHighlightId] = useState<string | null>(null);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="square">{t("consult.tab_square")}</TabsTrigger>
        <TabsTrigger value="feed">{t("consult.tab_feed")}</TabsTrigger>
      </TabsList>
      <TabsContent value="square">
        <ConsultGrid
          highlightId={highlightId}
          onHighlightDone={() => setHighlightId(null)}
        />
      </TabsContent>
      <TabsContent value="feed">
        <AgentFeed
          onJumpToPublication={(id) => {
            setHighlightId(id);
            setTab("square");
          }}
        />
      </TabsContent>
    </Tabs>
  );
}
