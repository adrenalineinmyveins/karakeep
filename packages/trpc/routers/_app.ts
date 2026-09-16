import { router } from "../index";
import { adminAppRouter } from "./admin";
import { agentProfilesAppRouter } from "./agentProfiles";
import { apiKeysAppRouter } from "./apiKeys";
import { assetsAppRouter } from "./assets";
import { backupsAppRouter } from "./backups";
import { bookmarksAppRouter } from "./bookmarks";
import { canvasesAppRouter } from "./canvases";
import { chatsAppRouter } from "./chats";
import { configAppRouter } from "./config";
import { conceptsAppRouter } from "./concepts";
import { feedsAppRouter } from "./feeds";
import { highlightsAppRouter } from "./highlights";
import { importSessionsRouter } from "./importSessions";
import { invitesAppRouter } from "./invites";
import { listsAppRouter } from "./lists";
import { memoriesAppRouter } from "./memories";
import { mirrorAppRouter } from "./mirror";
import { promptsAppRouter } from "./prompts";
import { publicBookmarks } from "./publicBookmarks";
import { publicSharedAssets, sharedAssetsAppRouter } from "./sharedAssets";
import { rulesAppRouter } from "./rules";
import { subscriptionsRouter } from "./subscriptions";
import { tagsAppRouter } from "./tags";
import { usersAppRouter } from "./users";
import { webhooksAppRouter } from "./webhooks";
import { widgetsAppRouter } from "./widgets";

export const appRouter = router({
  bookmarks: bookmarksAppRouter,
  chats: chatsAppRouter,
  memories: memoriesAppRouter,
  agentProfiles: agentProfilesAppRouter,
  canvases: canvasesAppRouter,
  widgets: widgetsAppRouter,
  apiKeys: apiKeysAppRouter,
  users: usersAppRouter,
  lists: listsAppRouter,
  tags: tagsAppRouter,
  prompts: promptsAppRouter,
  admin: adminAppRouter,
  feeds: feedsAppRouter,
  backups: backupsAppRouter,
  highlights: highlightsAppRouter,
  importSessions: importSessionsRouter,
  webhooks: webhooksAppRouter,
  assets: assetsAppRouter,
  rules: rulesAppRouter,
  invites: invitesAppRouter,
  publicBookmarks: publicBookmarks,
  publicSharedAssets: publicSharedAssets,
  sharedAssets: sharedAssetsAppRouter,
  subscriptions: subscriptionsRouter,
  config: configAppRouter,
  mirror: mirrorAppRouter,
  concepts: conceptsAppRouter,
});
// export type definition of API
export type AppRouter = typeof appRouter;
