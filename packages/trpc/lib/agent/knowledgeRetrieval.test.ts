import { describe, expect, it, vi } from "vitest";

// 模块顶层 import 会打开 SQLite 连接；纯函数测试不需要真实 db
vi.mock("@saiye/db", () => ({ db: {} }));

import {
  applyKnowledgeBudget,
  stripHtml,
  tokenizeQuery,
} from "./knowledgeRetrieval";
import type { KnowledgeChunk } from "./knowledgeRetrieval";

describe("tokenizeQuery", () => {
  it("中文切成 2-gram（连续段内组合）", () => {
    expect(tokenizeQuery("机器学习")).toEqual(["机器", "器学", "学习"]);
  });

  it("跨标点不组合 2-gram", () => {
    expect(tokenizeQuery("你好，世界")).toEqual(["你好", "世界"]);
  });

  it("英文按整词切分并小写化", () => {
    expect(tokenizeQuery("React Hooks")).toEqual(["react", "hooks"]);
  });

  it("过滤停用词", () => {
    // "帮我"/"看看" 是停用词，其余 gram 保留
    expect(tokenizeQuery("帮我看看部署")).toEqual(["我看", "看部", "部署"]);
  });

  it("最多返回 16 个 token", () => {
    // 18 个汉字 → 17 个 gram，截断到 16
    const tokens = tokenizeQuery("一二三四五六七八九十甲乙丙丁戊己庚辛");
    expect(tokens).toHaveLength(16);
  });

  it("句首虚词不挤占句中实词 token（回归：MAX_TOKENS 曾为 8）", () => {
    const tokens = tokenizeQuery(
      "我之前保存过关于书签或小组件方面的内容吗？简单列一下",
    );
    // "书签"/"小组"/"组件" 位于 gram 序列第 9~13 位，必须保留
    expect(tokens).toContain("书签");
    expect(tokens).toContain("小组");
    expect(tokens).toContain("组件");
  });

  it("单个汉字/无有效内容返回空", () => {
    expect(tokenizeQuery("好")).toEqual([]);
    expect(tokenizeQuery("")).toEqual([]);
  });
});

describe("stripHtml", () => {
  it("去除标签并保留正文文本", () => {
    expect(stripHtml("<p>你好<b>世界</b></p>")).toBe("你好 世界");
  });

  it("去除 script/style 块（内容也一并去掉）", () => {
    const html =
      "<style>.a{color:red}</style><div>正文</div><script>evil()</script>";
    expect(stripHtml(html)).toBe("正文");
  });

  it("去除 HTML 注释", () => {
    expect(stripHtml("前<!-- 注释 -->后")).toBe("前 后");
  });

  it("解码常见实体", () => {
    expect(
      stripHtml("a&nbsp;b &amp; c &lt;d&gt; &#39;e&#39; &quot;f&quot;"),
    ).toBe("a b & c <d> 'e' \"f\"");
  });

  it("压缩连续空白为单空格", () => {
    expect(stripHtml("a\n\t  b")).toBe("a b");
  });

  it("空串与纯标签返回空", () => {
    expect(stripHtml("")).toBe("");
    expect(stripHtml("<br/><hr>")).toBe("");
  });
});

describe("applyKnowledgeBudget", () => {
  const chunk = (
    source: KnowledgeChunk["source"],
    content: string,
    viaGraph = false,
  ): KnowledgeChunk => ({ source, content, viaGraph: viaGraph || undefined });

  it("优先级排序：记忆 > 直接命中 > 对话记忆 > 图谱扩展", () => {
    // 乱序输入：图谱/对话在前，记忆最后
    const chunks = [
      chunk("bookmark", "b", true),
      chunk("chat", "c"),
      chunk("bookmark", "a"),
      chunk("memory", "m"),
    ];
    const result = applyKnowledgeBudget(chunks, 100_000);
    expect(result.map((c) => c.content)).toEqual(["m", "a", "c", "b"]);
  });

  it("超预算的片段被丢弃，放得下的仍可进入（continue 语义）", () => {
    const chunks = [
      chunk("bookmark", "x".repeat(600)), // 大片段
      chunk("chat", "y".repeat(50)), // 小片段，可挤进剩余预算
    ];
    // 预算 600：bookmark 片段 600 + 100 开销 = 700 放不下；
    // chat 片段 50 + 100 = 150 ≤ 600 放得下
    const result = applyKnowledgeBudget(chunks, 600);
    expect(result.map((c) => c.content[0])).toEqual(["y"]);
  });

  it("预算充足时全部保留", () => {
    const chunks = [
      chunk("memory", "m"),
      chunk("bookmark", "a"),
      chunk("chat", "c"),
      chunk("bookmark", "g", true),
    ];
    expect(applyKnowledgeBudget(chunks, 100_000)).toHaveLength(4);
  });
});
