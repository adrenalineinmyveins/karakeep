// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";

import {
  MAX_ENTRIES,
  STORAGE_KEY,
  addWidgetActivity,
  clearWidgetActivity,
  getWidgetActivity,
  summarizeWidgetWrite,
} from "./audit";

describe("widget 活动日志（W3，§7.2）", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  test("add/get 往返，最新记录在前", () => {
    addWidgetActivity({
      widgetId: "w1",
      widgetName: "快速保存",
      action: "bookmarks.create",
      outcome: "ok",
      summary: "新建书签《测试》",
    });
    addWidgetActivity({
      widgetId: "w1",
      widgetName: "快速保存",
      action: "tags.create",
      outcome: "ok",
      summary: "新建标签「inbox」",
    });
    const list = getWidgetActivity();
    expect(list).toHaveLength(2);
    expect(list[0]?.action).toBe("tags.create");
    expect(list[1]?.action).toBe("bookmarks.create");
    expect(list[0]?.id).toBeTruthy();
    expect(typeof list[0]?.ts).toBe("number");
  });

  test("容量上限 100 条：写入 105 条只保留最新 100 条", () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      addWidgetActivity({
        widgetId: "w1",
        widgetName: "失控组件",
        action: "bookmarks.create",
        outcome: "ok",
        summary: `第 ${i} 次`,
      });
    }
    const list = getWidgetActivity();
    expect(list).toHaveLength(MAX_ENTRIES);
    // 最新一条是最后写入的（summary 单调递增）
    expect(list[0]?.summary).toBe(`第 ${MAX_ENTRIES + 4} 次`);
    expect(list[MAX_ENTRIES - 1]?.summary).toBe("第 5 次");
  });

  test("localStorage 破损数据返回空数组（静默降级）", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(getWidgetActivity()).toEqual([]);
  });

  test("clear 清空记录", () => {
    addWidgetActivity({
      widgetId: "w1",
      widgetName: "x",
      action: "widget.install",
      outcome: "ok",
      summary: "安装",
    });
    clearWidgetActivity();
    expect(getWidgetActivity()).toEqual([]);
  });

  test("写摘要：新建书签取结果标题", () => {
    expect(
      summarizeWidgetWrite(
        "bookmarks.create",
        { type: "link" },
        {
          id: "abc123456789",
          title: "Vue 文档",
        },
      ),
    ).toBe("新建书签 《Vue 文档》");
  });

  test("写摘要：结果无标题回退 ID 前 8 位", () => {
    expect(
      summarizeWidgetWrite(
        "bookmarks.create",
        { type: "text" },
        {
          id: "abc123456789",
          title: null,
        },
      ),
    ).toBe("新建书签 #abc12345");
  });

  test("写摘要：删除书签显示 ID 前 8 位", () => {
    expect(
      summarizeWidgetWrite(
        "bookmarks.delete",
        { bookmarkId: "deadbeef1234" },
        null,
      ),
    ).toBe("删除书签 #deadbeef");
  });

  test("写摘要：setTags 显示增减数量", () => {
    expect(
      summarizeWidgetWrite(
        "bookmarks.setTags",
        {
          bookmarkId: "b1",
          attach: [{ tagName: "a" }],
          detach: [{ tagId: "t1" }, { tagId: "t2" }],
        },
        null,
      ),
    ).toBe("为书签 #b1 打标签（+1 / -2）");
  });

  test("写摘要：清单成员变更", () => {
    expect(
      summarizeWidgetWrite(
        "lists.addToList",
        { listId: "l1", bookmarkId: "b1" },
        null,
      ),
    ).toBe("把书签 #b1 加入清单 #l1");
    expect(
      summarizeWidgetWrite(
        "lists.removeFromList",
        { listId: "l1", bookmarkId: "b1" },
        null,
      ),
    ).toBe("把书签 #b1 移出清单 #l1");
  });

  test("写摘要：输入缺失字段时回退 #unknown（best-effort 不抛错）", () => {
    expect(summarizeWidgetWrite("bookmarks.update", undefined, null)).toBe(
      "更新书签 #unknown",
    );
    expect(summarizeWidgetWrite("tags.create", null, null)).toBe(
      "新建标签「?」",
    );
  });
});
