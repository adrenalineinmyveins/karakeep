import { ScrollView, View } from "react-native";

import { useWhoAmI } from "@saiye/shared-react/hooks/users";
import type { ZBookmark } from "@saiye/shared/types/bookmarks";
import { isBookmarkStillTagging } from "@saiye/shared/utils/bookmarkUtils";

import { Skeleton } from "../../ui/Skeleton";
import TagPill from "../TagPill";

function TagListSkeleton() {
  return (
    <View className="w-full">
      <Skeleton className="h-[18px] w-full rounded-full" />
    </View>
  );
}

export default function TagList({ bookmark }: { bookmark: ZBookmark }) {
  const tags = bookmark.tags;
  const { data: currentUser } = useWhoAmI();
  const isOwner = currentUser?.id === bookmark.userId;

  if (isBookmarkStillTagging(bookmark)) {
    return <TagListSkeleton />;
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex flex-row gap-2">
        {tags.map((t) => (
          <TagPill key={t.id} tag={t} clickable={isOwner} />
        ))}
      </View>
    </ScrollView>
  );
}
