import { beforeEach, describe, expect, test } from "vitest";

import { MAX_MEMORIES } from "./memories";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

describe("Memories Routes", () => {
  test<CustomTestContext>("create and list with capacity", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].memories;

    const created = await api.create({ content: "用户是后端工程师" });
    expect(created.deduplicated).toEqual(false);

    const list = await api.list();
    expect(list.memories.length).toEqual(1);
    expect(list.memories[0].content).toEqual("用户是后端工程师");
    expect(list.capacity).toEqual(MAX_MEMORIES);
  });

  test<CustomTestContext>("duplicate content refreshes instead of adding", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].memories;

    const first = await api.create({ content: "用户偏好简洁的回答" });
    await new Promise((r) => setTimeout(r, 5)); // 确保 modifiedAt 有区分度
    const second = await api.create({ content: "用户偏好简洁的回答" });

    expect(second.deduplicated).toEqual(true);
    expect(second.id).toEqual(first.id);
    expect(second.modifiedAt!.getTime()).toBeGreaterThan(
      first.modifiedAt!.getTime(),
    );

    const list = await api.list();
    expect(list.memories.length).toEqual(1);
  });

  test<CustomTestContext>("rejects create when at capacity; delete frees a slot", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].memories;

    for (let i = 0; i < MAX_MEMORIES; i++) {
      await api.create({ content: `记忆 ${i}` });
    }
    expect((await api.list()).memories.length).toEqual(MAX_MEMORIES);

    // 已满：拒绝并提示清理
    await expect(api.create({ content: "超限的新记忆" })).rejects.toThrowError(
      /记忆已满/,
    );

    // 删除一条后可再存
    const list = await api.list();
    await api.delete({ id: list.memories[0].id });
    const created = await api.create({ content: "超限的新记忆" });
    expect(created.deduplicated).toEqual(false);
  });

  test<CustomTestContext>("update rewrites content owned by the user", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0].memories;
    const created = await api.create({ content: "用户偏好详细的回答" });

    const updated = await api.update({
      id: created.id,
      content: "用户偏好简洁的回答",
    });
    expect(updated?.content).toEqual("用户偏好简洁的回答");

    // 其他用户不可更新（归属校验失败返回 null，数据不变）
    const other = await apiCallers[1].memories.update({
      id: created.id,
      content: "篡改内容",
    });
    expect(other).toBeNull();
    const list = await api.list();
    expect(list.memories[0].content).toEqual("用户偏好简洁的回答");
  });

  test<CustomTestContext>("memories are isolated per user", async ({
    apiCallers,
  }) => {
    await apiCallers[0].memories.create({ content: "用户1的记忆" });
    await apiCallers[1].memories.create({ content: "用户1的记忆" });

    // 同内容对不同用户各自保存，互不可见
    expect((await apiCallers[0].memories.list()).memories.length).toEqual(1);
    expect((await apiCallers[1].memories.list()).memories.length).toEqual(1);
  });
});
