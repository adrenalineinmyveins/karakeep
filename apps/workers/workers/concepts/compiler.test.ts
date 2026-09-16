import { describe, expect, test, vi } from "vitest";

vi.mock("@saiye/db", () => ({ db: {} }));
vi.mock("@saiye/db/schema", () => ({
  bookmarkLists: {},
  bookmarkTags: {},
  bookmarks: {},
  bookmarksInLists: {},
  conceptPageSources: {},
  conceptPages: {},
  tagsOnBookmarks: {},
}));
vi.mock("@saiye/shared-server", () => ({
  triggerConceptMirrorExport: vi.fn(),
}));
vi.mock("@saiye/shared/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../mirrorExport", () => ({
  htmlToMarkdown: (html: string) => html,
}));

import { buildCompilePrompt, computeSourceHash } from "./compiler";
import type { ConceptSource } from "./compiler";

function source(overrides: Partial<ConceptSource>): ConceptSource {
  return {
    bookmarkId: "bm1",
    title: "标题",
    url: null,
    summary: null,
    content: null,
    modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("computeSourceHash", () => {
  test("同一来源集合（含 modifiedAt）产生稳定 hash", () => {
    const sources = [
      source({ bookmarkId: "bm1" }),
      source({ bookmarkId: "bm2" }),
    ];
    expect(computeSourceHash(sources)).toEqual(computeSourceHash(sources));
  });

  test("modifiedAt 变化 → hash 变化（对账能检出 stale）", () => {
    const before = [source({ bookmarkId: "bm1" })];
    const after = [
      source({ modifiedAt: new Date("2026-02-01T00:00:00.000Z") }),
    ];
    expect(computeSourceHash(before)).not.toEqual(computeSourceHash(after));
  });

  test("来源增删与顺序变化 → hash 变化", () => {
    const one = [source({ bookmarkId: "bm1" })];
    const two = [source({ bookmarkId: "bm1" }), source({ bookmarkId: "bm2" })];
    const reversed = [...two].reverse();
    expect(computeSourceHash(one)).not.toEqual(computeSourceHash(two));
    expect(computeSourceHash(two)).not.toEqual(computeSourceHash(reversed));
  });

  test("空集合也有确定值", () => {
    expect(computeSourceHash([])).toEqual(computeSourceHash([]));
  });
});

describe("buildCompilePrompt", () => {
  const sources = [
    source({
      bookmarkId: "bm1",
      title: "Rust Book",
      url: "https://doc.rust-lang.org",
      summary: "官方教程",
      content: "Ownership is the core concept.",
    }),
    source({ bookmarkId: "bm2", title: null, url: null, content: null }),
  ];

  test("按序编号列出材料，包含标题、URL、摘要与正文节选", () => {
    const prompt = buildCompilePrompt("rust", "tag", sources);
    expect(prompt).toContain("「rust」");
    expect(prompt).toContain("[1] 标题: Rust Book");
    expect(prompt).toContain("URL: https://doc.rust-lang.org");
    expect(prompt).toContain("摘要: 官方教程");
    expect(prompt).toContain("Ownership is the core concept.");
    expect(prompt).toContain("[2] 标题: (无标题)");
  });

  test("包含溯源与防幻觉约束", () => {
    const prompt = buildCompilePrompt("rust", "tag", sources);
    expect(prompt).toContain("[n]");
    expect(prompt).toContain("禁止编造");
    expect(prompt).toContain("观点冲突");
  });

  test("锚点类型区分标签与清单", () => {
    expect(buildCompilePrompt("a", "tag", [])).toContain("标签");
    expect(buildCompilePrompt("a", "list", [])).toContain("清单");
  });
});
