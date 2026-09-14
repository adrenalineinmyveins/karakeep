import { describe, expect, it } from "vitest";

import {
  zWidgetBookmarkCreateSchema,
  zWidgetBookmarkUpdateSchema,
  zWidgetPermissionSchema,
  zWidgetSetTagsSchema,
} from "@saiye/shared/types/widgets";

import { buildSandboxDoc } from "./runtime";

/**
 * 沙箱文档结构校验（M5 加固回归项：升级宿主不破坏已装组件的渲染契约）。
 * 真实浏览器行为（opaque origin / CSP 阻断 fetch）无法在 vitest 里验证，
 * 此处锁定文档结构关键标记，防止重构时无意丢失。
 */
describe("buildSandboxDoc", () => {
  const doc = buildSandboxDoc('<div id="root"></div>', "light");

  it("注入错误占位逻辑：捕获同步错误与未处理的 Promise 拒绝", () => {
    expect(doc).toContain("window.addEventListener('error'");
    expect(doc).toContain("window.addEventListener('unhandledrejection'");
  });

  it("错误占位用 textContent 渲染（不引入 innerHTML 注入面）", () => {
    expect(doc).toContain("box.textContent");
    expect(doc).not.toContain("innerHTML");
  });

  it("保留既有契约：CSP 封网、SDK 注入、用户代码、桥超时", () => {
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("window.saiye = saiye");
    expect(doc).toContain('<div id="root"></div>');
    expect(doc).toContain("timed out");
  });

  it("主题变量随明暗切换注入", () => {
    const dark = buildSandboxDoc("<div>x</div>", "dark");
    expect(dark).toContain('<html class="dark">');
    expect(dark).toContain("--background: #0a0a0a");
  });

  it("SDK 监听宿主回执并 settle 挂起调用（W4 回归：缺失会导致所有调用超时）", () => {
    expect(doc).toContain("window.addEventListener('message'");
    expect(doc).toContain("clearTimeout(cb.timer)");
    expect(doc).toContain("cb.resolve(d.data)");
    expect(doc).toContain("cb.reject(new Error(d.error");
  });

  it("注入 v1 写 SDK：9 个写方法 + 60s 写超时（读保持 30s）", () => {
    const writeMethods = [
      "bookmarks.create",
      "bookmarks.update",
      "bookmarks.setTags",
      "bookmarks.delete",
      "tags.create",
      "tags.delete",
      "lists.create",
      "lists.addToList",
      "lists.removeFromList",
      "lists.delete",
    ];
    for (const m of writeMethods) {
      expect(doc).toContain(`call('${m}'`);
    }
    expect(doc).toContain("WRITE_TIMEOUT = 60000");
    expect(doc).toContain("timeoutMs || 30000");
  });
});

describe("v1 写权限与窄化 schema（W1）", () => {
  it("权限枚举包含 9 个三级权限值", () => {
    const values = zWidgetPermissionSchema.options;
    expect(values).toHaveLength(9);
    expect(values).toContain("bookmarks:write");
    expect(values).toContain("lists:delete");
    expect(() => zWidgetPermissionSchema.parse("bookmarks:admin")).toThrow();
  });

  it("bookmarks.update 窄化：白名单字段通过，越界字段（url/description）被拒", () => {
    expect(
      zWidgetBookmarkUpdateSchema.safeParse({
        bookmarkId: "b1",
        title: "新标题",
        archived: true,
      }).success,
    ).toBe(true);
    expect(
      zWidgetBookmarkUpdateSchema.safeParse({
        bookmarkId: "b1",
        url: "https://evil.example.com",
      }).success,
    ).toBe(false);
  });

  it("bookmarks.create 窄化：source / crawlPriority 等服务端字段被拒", () => {
    expect(
      zWidgetBookmarkCreateSchema.safeParse({
        type: "link",
        url: "https://example.com",
        title: "x",
      }).success,
    ).toBe(true);
    expect(
      zWidgetBookmarkCreateSchema.safeParse({
        type: "text",
        text: "hi",
        source: "api",
      }).success,
    ).toBe(false);
  });

  it("setTags 窄化：attach/detach 按名或按 ID，未知字段被拒", () => {
    expect(
      zWidgetSetTagsSchema.safeParse({
        bookmarkId: "b1",
        attach: [{ tagName: "待读" }],
        detach: [{ tagId: "t1" }],
      }).success,
    ).toBe(true);
    expect(
      zWidgetSetTagsSchema.safeParse({
        bookmarkId: "b1",
        attach: [{ tagName: "x", extra: 1 }],
        detach: [],
      }).success,
    ).toBe(false);
  });
});
