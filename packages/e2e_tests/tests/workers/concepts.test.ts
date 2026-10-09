import { beforeEach, describe, expect, inject, it } from "vitest";

import { createSaiyeClient } from "@saiye/sdk";

import { createTestUser } from "../../utils/api";
import { waitUntil } from "../../utils/general";
import { getTrpcClient } from "../../utils/trpc";

const FIXTURE_CONTENT =
  "## 核心概念\n\n概念页 E2E 编译摘要 [1]。\n\n## 实践要点\n\n来自材料的实践要点 [1]。";

describe("Concept Compilation Worker Tests", () => {
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

  async function createTaggedBookmark(tagName: string) {
    const { data: bookmark, error } = await client.POST("/bookmarks", {
      body: {
        type: "text",
        title: `Bookmark for ${tagName}`,
        text: `E2E material body for ${tagName}.`,
      },
    });
    if (error) {
      throw error;
    }

    const { data: attachRes, error: attachError } = await client.POST(
      "/bookmarks/{bookmarkId}/tags",
      {
        params: {
          path: {
            bookmarkId: bookmark!.id,
          },
        },
        body: {
          tags: [{ tagName }],
        },
      },
    );
    if (attachError) {
      throw attachError;
    }

    return { bookmarkId: bookmark!.id, tagId: attachRes!.attached[0]! };
  }

  async function waitForReady(tagId: string, description: string) {
    await waitUntil(
      async () => {
        const status = await trpc.concepts.anchorStatus.query({
          anchorType: "tag",
          anchorId: tagId,
        });
        return status.status === "ready";
      },
      description,
      120000,
    );
  }

  it("compiles a tag-anchored concept page end to end", async () => {
    const { tagId, bookmarkId } = await createTaggedBookmark("向量数据库");
    const created = await trpc.concepts.create.mutate({
      anchorType: "tag",
      anchorId: tagId,
    });

    await waitForReady(tagId, "Concept compilation completes");

    const detail = await trpc.concepts.get.query({ slug: created.slug });
    expect(detail.concept.status).toBe("ready");
    expect(detail.concept.sourceCount).toBe(1);
    expect(detail.concept.compileVersion).toBe(1);
    expect(detail.concept.lastCompiledAt).not.toBeNull();
    expect(detail.concept.lastError).toBeNull();
    expect(detail.content).toBe(FIXTURE_CONTENT);
    expect(detail.anchorName).toBe("向量数据库");
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]!.bookmarkId).toBe(bookmarkId);
    expect(detail.sources[0]!.title).toBe("Bookmark for 向量数据库");
  }, 180000);

  it("recompiles an existing concept page", async () => {
    const { tagId } = await createTaggedBookmark("recompile-anchor");
    const created = await trpc.concepts.create.mutate({
      anchorType: "tag",
      anchorId: tagId,
    });
    await waitForReady(tagId, "Initial concept compilation completes");

    await trpc.concepts.recompile.mutate({ conceptId: created.conceptId });

    await waitUntil(
      async () => {
        const detail = await trpc.concepts.get.query({ slug: created.slug });
        return (
          detail.concept.status === "ready" &&
          detail.concept.compileVersion >= 2
        );
      },
      "Concept recompilation completes",
      120000,
    );

    const detail = await trpc.concepts.get.query({ slug: created.slug });
    expect(detail.concept.compileVersion).toBe(2);
    expect(detail.content).toBe(FIXTURE_CONTENT);
  }, 180000);

  it("compiles an anchor without bookmarks into an empty page", async () => {
    const { data: tag, error } = await client.POST("/tags", {
      body: { name: "空锚点" },
    });
    if (error) {
      throw error;
    }

    const created = await trpc.concepts.create.mutate({
      anchorType: "tag",
      anchorId: tag!.id,
    });

    await waitForReady(tag!.id, "Empty-anchor compilation completes");

    const detail = await trpc.concepts.get.query({ slug: created.slug });
    expect(detail.concept.status).toBe("ready");
    expect(detail.concept.sourceCount).toBe(0);
    expect(detail.content).toBe("");
    expect(detail.sources).toHaveLength(0);
  }, 180000);
});
