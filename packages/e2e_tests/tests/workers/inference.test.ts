import { assert, beforeEach, describe, expect, inject, it } from "vitest";

import { createSaiyeClient } from "@saiye/sdk";

import { createTestUser } from "../../utils/api";
import { waitUntil } from "../../utils/general";
import { getTrpcClient } from "../../utils/trpc";

describe("Inference Worker Tests", () => {
  const port = inject("saiyePort");

  if (!port) {
    throw new Error("Missing required environment variables");
  }

  let client: ReturnType<typeof createSaiyeClient>;
  let trpc: ReturnType<typeof getTrpcClient>;
  let apiKey: string;

  beforeEach(async () => {
    apiKey = await createTestUser();
    client = createSaiyeClient({
      baseUrl: `http://localhost:${port}/api/v1/`,
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    });
    trpc = getTrpcClient(apiKey);
  });

  it("auto-tags text bookmarks", async () => {
    await trpc.users.updateSettings.mutate({
      autoTaggingEnabled: true,
    });

    const { data: createdBookmark, error } = await client.POST("/bookmarks", {
      body: {
        type: "text",
        title: "Inference text bookmark",
        text: "Saiye should tag this bookmark through the inference worker.",
      },
    });

    if (error) {
      throw error;
    }
    assert(createdBookmark);

    await waitUntil(async () => {
      const { data: bookmark } = await client.GET("/bookmarks/{bookmarkId}", {
        params: {
          path: {
            bookmarkId: createdBookmark.id,
          },
        },
      });

      return bookmark?.taggingStatus === "success";
    }, "Text bookmark tagging completes");

    const { data: bookmark } = await client.GET("/bookmarks/{bookmarkId}", {
      params: {
        path: {
          bookmarkId: createdBookmark.id,
        },
      },
    });

    assert(bookmark);
    expect(bookmark.taggingStatus).toBe("success");
    expect(bookmark.tags.map((tag) => tag.name)).toEqual(
      expect.arrayContaining(["ai-generated", "saiye", "worker-test"]),
    );
  }, 120000);

  it("auto-tags and summarizes crawled link bookmarks", async () => {
    await trpc.users.updateSettings.mutate({
      autoTaggingEnabled: true,
      autoSummarizationEnabled: true,
    });

    const { data: createdBookmark, error } = await client.POST("/bookmarks", {
      body: {
        type: "link",
        title: "Inference link bookmark",
        url: "http://nginx:80/hello.html",
      },
    });

    if (error) {
      throw error;
    }
    assert(createdBookmark);

    await waitUntil(
      async () => {
        const { data: bookmark } = await client.GET("/bookmarks/{bookmarkId}", {
          params: {
            path: {
              bookmarkId: createdBookmark.id,
            },
          },
        });

        return (
          bookmark?.taggingStatus === "success" &&
          bookmark?.summarizationStatus === "success"
        );
      },
      "Link bookmark inference completes",
      120000,
    );

    const { data: bookmark } = await client.GET("/bookmarks/{bookmarkId}", {
      params: {
        path: {
          bookmarkId: createdBookmark.id,
        },
      },
    });

    assert(bookmark);
    expect(bookmark.taggingStatus).toBe("success");
    expect(bookmark.summarizationStatus).toBe("success");
    expect(bookmark.summary).toBe(
      "This page contains a short Hello World test document used to verify Saiye's inference worker end-to-end.",
    );
    expect(bookmark.tags.map((tag) => tag.name)).toEqual(
      expect.arrayContaining(["ai-generated", "saiye", "worker-test"]),
    );
  }, 120000);
});
