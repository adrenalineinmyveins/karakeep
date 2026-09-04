import { createSaiyeClient } from "@saiye/sdk";

import type { Bookmark } from "./types";
import { config } from "./config";

export class SaiyeAPIClient {
  private readonly client: ReturnType<typeof createSaiyeClient>;

  constructor() {
    this.client = createSaiyeClient({
      baseUrl: `${config.SAIYE_SERVER_ADDR}/api/v1/`,
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${config.SAIYE_API_KEY}`,
      },
    });
  }

  async fetchBookmarks(limit: number): Promise<Bookmark[]> {
    const bookmarks: Bookmark[] = [];
    let cursor: string | null = null;
    let hasMore = true;

    while (hasMore && bookmarks.length < limit) {
      const params: {
        limit: number;
        includeContent: true;
        archived?: boolean;
        cursor?: string;
      } = {
        limit: Math.min(limit - bookmarks.length, 50),
        includeContent: true,
        archived: false,
      };

      if (cursor) {
        params.cursor = cursor;
      }

      const { data, response, error } = await this.client.GET("/bookmarks", {
        params: {
          query: params,
        },
      });

      if (error) {
        throw new Error(`Failed to fetch bookmarks: ${String(error)}`);
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch bookmarks: ${response.status}`);
      }

      const batchBookmarks = (data?.bookmarks || [])
        .filter((b) => b.content?.type === "link")
        .map((b) => ({
          ...b,
          tags: (b.tags || []).map((tag) => ({
            name: tag.name,
            attachedBy: tag.attachedBy,
          })),
        })) as Bookmark[];

      bookmarks.push(...batchBookmarks);
      cursor = data?.nextCursor || null;
      hasMore = !!cursor;
    }

    return bookmarks.slice(0, limit);
  }
}
