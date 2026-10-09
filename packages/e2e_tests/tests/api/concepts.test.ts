import { beforeEach, describe, expect, inject, it } from "vitest";

import { createSaiyeClient } from "@saiye/sdk";

import { createTestUser } from "../../utils/api";
import { getTrpcClient } from "../../utils/trpc";

describe("Concepts API", () => {
  const port = inject("saiyePort");

  if (!port) {
    throw new Error("Missing required environment variables");
  }

  let client: ReturnType<typeof createSaiyeClient>;
  let trpc: ReturnType<typeof getTrpcClient>;
  let otherTrpc: ReturnType<typeof getTrpcClient>;
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
    otherTrpc = getTrpcClient(await createTestUser());
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

  it("should reject creating a concept for a missing anchor", async () => {
    await expect(
      trpc.concepts.create.mutate({
        anchorType: "tag",
        anchorId: "does-not-exist",
      }),
    ).rejects.toThrow(/Anchor not found/);
  });

  it("should create, get, list and delete a concept page", async () => {
    const { tagId } = await createTaggedBookmark("向量数据库");
    const anchorInput = { anchorType: "tag" as const, anchorId: tagId };

    const before = await trpc.concepts.anchorStatus.query(anchorInput);
    expect(before.conceptId).toBeNull();
    expect(before.inferenceConfigured).toBe(true);

    const created = await trpc.concepts.create.mutate(anchorInput);
    expect(created.conceptId).toBeDefined();
    expect(created.slug).toBe("向量数据库");

    const status = await trpc.concepts.anchorStatus.query(anchorInput);
    expect(status.conceptId).toBe(created.conceptId);
    expect(status.slug).toBe("向量数据库");

    const detail = await trpc.concepts.get.query({ slug: created.slug });
    expect(detail.concept.id).toBe(created.conceptId);
    expect(detail.concept.title).toBe("向量数据库");
    expect(detail.concept.anchorType).toBe("tag");
    expect(detail.concept.anchorId).toBe(tagId);
    expect(detail.anchorName).toBe("向量数据库");
    expect(typeof detail.content).toBe("string");

    const list = await trpc.concepts.list.query();
    expect(list.concepts.map((c) => c.id)).toContain(created.conceptId);

    await trpc.concepts.delete.mutate({ conceptId: created.conceptId });

    await expect(
      trpc.concepts.get.query({ slug: created.slug }),
    ).rejects.toThrow(/Concept not found/);

    const after = await trpc.concepts.anchorStatus.query(anchorInput);
    expect(after.conceptId).toBeNull();

    const recreated = await trpc.concepts.create.mutate(anchorInput);
    expect(recreated.conceptId).not.toBe(created.conceptId);
  });

  it("should not create a duplicate concept for the same anchor", async () => {
    const { tagId } = await createTaggedBookmark("duplicated-anchor");
    const anchorInput = { anchorType: "tag" as const, anchorId: tagId };

    await trpc.concepts.create.mutate(anchorInput);
    await expect(trpc.concepts.create.mutate(anchorInput)).rejects.toThrow(
      /already exists/,
    );
  });

  it("should isolate concepts between users", async () => {
    const { tagId } = await createTaggedBookmark("private-anchor");
    const created = await trpc.concepts.create.mutate({
      anchorType: "tag",
      anchorId: tagId,
    });

    await expect(
      otherTrpc.concepts.get.query({ slug: created.slug }),
    ).rejects.toThrow(/Concept not found/);

    await expect(
      otherTrpc.concepts.recompile.mutate({ conceptId: created.conceptId }),
    ).rejects.toThrow(/Concept not found/);

    await expect(
      otherTrpc.concepts.delete.mutate({ conceptId: created.conceptId }),
    ).rejects.toThrow(/Concept not found/);

    const list = await otherTrpc.concepts.list.query();
    expect(list.concepts.map((c) => c.id)).not.toContain(created.conceptId);
  });

  it("should suffix the slug when two anchors collide", async () => {
    const { data: tagA } = await client.POST("/tags", {
      body: { name: "concept page" },
    });
    const { data: tagB } = await client.POST("/tags", {
      body: { name: "concept-page" },
    });
    expect(tagA).toBeDefined();
    expect(tagB).toBeDefined();

    const first = await trpc.concepts.create.mutate({
      anchorType: "tag",
      anchorId: tagA!.id,
    });
    expect(first.slug).toBe("concept-page");

    const second = await trpc.concepts.create.mutate({
      anchorType: "tag",
      anchorId: tagB!.id,
    });
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug!.startsWith("concept-page-")).toBe(true);

    const detailFirst = await trpc.concepts.get.query({ slug: first.slug });
    expect(detailFirst.concept.id).toBe(first.conceptId);
    const detailSecond = await trpc.concepts.get.query({ slug: second.slug });
    expect(detailSecond.concept.id).toBe(second.conceptId);
  });
});
