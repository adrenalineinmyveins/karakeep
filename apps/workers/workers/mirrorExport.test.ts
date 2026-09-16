import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@saiye/db", () => ({ db: {} }));
vi.mock("@saiye/db/schema", () => ({
  bookmarkLists: {},
  bookmarks: {},
  conceptPageSources: {},
  conceptPages: {},
  bookmarkTags: {},
  highlights: {},
}));
vi.mock("@saiye/shared/config", () => ({
  default: { mirrorExport: { enabled: true, dir: "/unused" } },
}));
vi.mock("@saiye/shared/logger", () => ({
  default: { info: vi.fn() },
}));

import {
  buildConceptMarkdownDocument,
  buildFrontmatter,
  buildIndexDocument,
  buildMarkdownDocument,
  deleteMirrorFile,
  exportMirrorFile,
  htmlToMarkdown,
  mirrorFilePath,
} from "./mirrorExport";
import type {
  IndexBookmarkEntry,
  MirrorBookmarkData,
  MirrorConceptData,
} from "./mirrorExport";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mirror-test-"));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("buildFrontmatter", () => {
  test("serializes values as JSON (valid YAML) and drops undefined", () => {
    const fm = buildFrontmatter({
      title: "A: title",
      tags: ["a", "b"],
      url: null,
      gone: undefined,
    });
    expect(fm).toBe(
      ["---", 'title: "A: title"', 'tags: ["a","b"]', "url: null", "---"].join(
        "\n",
      ),
    );
  });
});

describe("htmlToMarkdown", () => {
  test("converts html to markdown", () => {
    expect(htmlToMarkdown("<h1>Hi</h1><p>there</p>")).toBe("# Hi\n\nthere");
  });
});

describe("mirrorFilePath", () => {
  test("nests files under the user directory, named by bookmark id", () => {
    const p = mirrorFilePath("/root", "user1", "bm1");
    expect(p).toBe(path.join("/root", "user1", "bm1.md"));
  });
});

describe("buildMarkdownDocument", () => {
  const base: MirrorBookmarkData = {
    id: "bm1",
    userId: "user1",
    type: "link",
    title: "Some Title",
    url: "https://example.com",
    summary: "A summary",
    note: "My note",
    archived: false,
    favourited: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    modifiedAt: new Date("2026-02-02T00:00:00.000Z"),
    tags: ["tech", "reading"],
    lists: ["Reading/Tech"],
    content: "Body text",
    highlights: [
      { text: "First highlight", note: null },
      { text: "Second highlight", note: "Why it matters" },
    ],
  };

  test("assembles frontmatter, title, summary, content, highlights and note", () => {
    const doc = buildMarkdownDocument(base);
    const lines = doc.split("\n");

    expect(lines[0]).toBe("---");
    expect(doc).toContain('id: "bm1"');
    expect(doc).toContain('type: "link"');
    expect(doc).toContain('url: "https://example.com"');
    expect(doc).toContain('tags: ["tech","reading"]');
    expect(doc).toContain('lists: ["Reading/Tech"]');
    expect(doc).toContain("favourited: true");
    expect(doc).toContain("# Some Title");
    expect(doc).toContain("> A summary");
    expect(doc).toContain("Body text");
    expect(doc).toContain("## Highlights");
    expect(doc).toContain("> First highlight");
    expect(doc).toContain("> Second highlight");
    expect(doc).toContain("> **Note:** Why it matters");
    expect(doc).toContain("## Note");
    expect(doc).toContain("My note");
  });

  test("omits optional sections when absent", () => {
    const doc = buildMarkdownDocument({
      ...base,
      title: null,
      summary: null,
      note: null,
      content: null,
      highlights: [],
    });
    expect(doc).not.toContain("# ");
    expect(doc).not.toContain("## Highlights");
    expect(doc).not.toContain("## Note");
  });
});

describe("buildConceptMarkdownDocument", () => {
  const conceptData: MirrorConceptData = {
    id: "cp1",
    title: "Rust 生态综述",
    anchorType: "tag",
    anchorName: "rust",
    status: "ready",
    content: "## 核心概念\n\n内存安全是首要目标 [1]。",
    lastCompiledAt: new Date("2026-03-01T00:00:00.000Z"),
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    sources: [
      {
        bookmarkId: "bm1",
        title: "Rust Book",
        url: "https://doc.rust-lang.org",
      },
      { bookmarkId: "bm2", title: null, url: null },
    ],
  };

  test("assembles concept frontmatter, body and numbered sources", () => {
    const doc = buildConceptMarkdownDocument(conceptData);
    const lines = doc.split("\n");

    expect(lines[0]).toBe("---");
    expect(doc).toContain('id: "cp1"');
    expect(doc).toContain('type: "concept"');
    expect(doc).toContain('title: "Rust 生态综述"');
    expect(doc).toContain('anchor: {"type":"tag","name":"rust"}');
    expect(doc).toContain('sources: ["../bm1.md","../bm2.md"]');
    expect(doc).toContain('status: "ready"');
    expect(doc).toContain("# Rust 生态综述");
    expect(doc).toContain("内存安全是首要目标 [1]。");
    expect(doc).toContain("## Sources");
    expect(doc).toContain("1. [[bm1|Rust Book]] — https://doc.rust-lang.org");
    // 无标题时退化为裸 wikilink，且不追加 URL 尾巴
    expect(doc).toContain("2. [[bm2]]");
  });

  test("shows a placeholder when not compiled yet", () => {
    const doc = buildConceptMarkdownDocument({
      ...conceptData,
      content: "",
      sources: [],
    });
    expect(doc).toContain("_（尚未编译）_");
    expect(doc).not.toContain("## Sources");
  });
});

describe("buildIndexDocument", () => {
  const entries: IndexBookmarkEntry[] = [
    {
      id: "bm1",
      title: "Rust Book",
      archived: false,
      lists: ["Reading/Tech"],
      tags: ["rust", "tech"],
    },
    {
      id: "bm2",
      title: null,
      archived: false,
      lists: [],
      tags: ["rust"],
    },
    {
      id: "bm3",
      title: "Old note",
      archived: true,
      lists: ["Reading/Tech"],
      tags: [],
    },
  ];

  test("groups by list, unfiled and archived, links concepts, counts tags", () => {
    const doc = buildIndexDocument(entries, [
      { slug: "rust-eco", title: "Rust 生态" },
    ]);

    expect(doc).toContain('type: "index"');
    expect(doc).toContain("# Index");
    expect(doc).toContain("## Concept Pages");
    expect(doc).toContain("- [[rust-eco|Rust 生态]]");
    expect(doc).toContain("### Reading/Tech");
    expect(doc).toContain("- [[bm1|Rust Book]]");
    expect(doc).toContain("## Unfiled");
    expect(doc).toContain("- [[bm2]]");
    expect(doc).toContain("## Archived");
    expect(doc).toContain("- [[bm3|Old note]]");
    // 标签按计数降序：rust (2) 在 tech (1) 前
    const rustIdx = doc.indexOf("- #rust (2)");
    const techIdx = doc.indexOf("- #tech (1)");
    expect(rustIdx).toBeGreaterThan(-1);
    expect(rustIdx).toBeLessThan(techIdx);
  });

  test("omits empty sections when there are no concepts/lists/tags", () => {
    const doc = buildIndexDocument(
      [{ id: "bm1", title: "Solo", archived: false, lists: [], tags: [] }],
      [],
    );
    expect(doc).not.toContain("## Concept Pages");
    expect(doc).not.toContain("## Lists");
    expect(doc).not.toContain("## Archived");
    expect(doc).not.toContain("## Tags");
    expect(doc).toContain("## Unfiled");
  });
});

describe("exportMirrorFile", () => {
  test("writes a new file and returns true", async () => {
    const written = await exportMirrorFile(tmpDir, "user1", "bm1", "hello");
    expect(written).toBe(true);
    await expect(
      fsp.readFile(path.join(tmpDir, "user1", "bm1.md"), "utf8"),
    ).resolves.toBe("hello");
  });

  test("skips the write when the content is unchanged", async () => {
    await exportMirrorFile(tmpDir, "user1", "bm1", "hello");
    const written = await exportMirrorFile(tmpDir, "user1", "bm1", "hello");
    expect(written).toBe(false);
  });

  test("rewrites when the content changed", async () => {
    await exportMirrorFile(tmpDir, "user1", "bm1", "hello");
    const written = await exportMirrorFile(tmpDir, "user1", "bm1", "world");
    expect(written).toBe(true);
    await expect(
      fsp.readFile(path.join(tmpDir, "user1", "bm1.md"), "utf8"),
    ).resolves.toBe("world");
  });
});

describe("deleteMirrorFile", () => {
  test("removes an existing file", async () => {
    await exportMirrorFile(tmpDir, "user1", "bm1", "hello");
    await deleteMirrorFile(tmpDir, "user1", "bm1");
    await expect(
      fsp.stat(path.join(tmpDir, "user1", "bm1.md")),
    ).rejects.toThrow();
  });

  test("does not throw when the file is already gone", async () => {
    await expect(
      deleteMirrorFile(tmpDir, "user1", "missing"),
    ).resolves.toBeUndefined();
  });
});
