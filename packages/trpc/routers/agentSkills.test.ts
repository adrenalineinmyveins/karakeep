import { beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";

import {
  agentProfiles,
  agentPublications,
  agentSkills,
  chatSessions,
  users,
} from "@saiye/db/schema";

import type { SkillToolGrant } from "@saiye/shared/types/agentSkills";

import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

async function createProfile(
  caller: CustomTestContext["apiCallers"][number],
  overrides: Record<string, unknown> = {},
) {
  return caller.agentProfiles.create({
    name: "Rust 专家",
    type: "openai-compatible",
    apiKey: "sk-test",
    baseUrl: "http://localhost:9999",
    model: "test-model",
    ...overrides,
  });
}

/** 用户 0 发布档案，返回 publication */
async function publishExpert(context: CustomTestContext) {
  const profile = await createProfile(context.apiCallers[0]);
  const { publication } = await context.apiCallers[0].agentPublications.publish(
    {
      agentProfileId: profile.id,
      title: "Rust 咨询",
      pricePerCall: 10,
    },
  );
  return publication;
}

const skillInput = {
  name: "深度阅读分析",
  description: "分析引用材料的核心论点与证据链",
  promptTemplate: "请分三步分析：1. 核心论点 2. 证据链 3. 适用场景",
  outputHint: "分点作答",
};

describe("Agent Skills (P1)", () => {
  test<CustomTestContext>("所有者可创建/列出/更新/删除技能", async (context) => {
    const profile = await createProfile(context.apiCallers[0]);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: profile.id,
      ...skillInput,
    });
    expect(skill.enabled).toBe(true);

    const { skills } = await context.apiCallers[0].agentSkills.list({
      profileId: profile.id,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("深度阅读分析");

    const { skill: updated } = await context.apiCallers[0].agentSkills.update({
      id: skill.id,
      ...skillInput,
      name: "改名后的技能",
      enabled: false,
    });
    expect(updated.name).toBe("改名后的技能");
    expect(updated.enabled).toBe(false);

    await context.apiCallers[0].agentSkills.delete({ id: skill.id });
    const { skills: after } = await context.apiCallers[0].agentSkills.list({
      profileId: profile.id,
    });
    expect(after).toHaveLength(0);
  });

  test<CustomTestContext>("非所有者无法操作他人档案的技能（list/create/update/delete 全部 NOT_FOUND）", async (context) => {
    const profile = await createProfile(context.apiCallers[0]);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: profile.id,
      ...skillInput,
    });

    await expect(
      context.apiCallers[1].agentSkills.list({ profileId: profile.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      context.apiCallers[1].agentSkills.create({
        profileId: profile.id,
        ...skillInput,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      context.apiCallers[1].agentSkills.update({ id: skill.id, ...skillInput }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // delete 按 userId 过滤删不到任何行（与 agentProfiles.delete 惯例一致，静默）
    await context.apiCallers[1].agentSkills.delete({ id: skill.id });

    // 原技能不受影响
    const { skills } = await context.apiCallers[0].agentSkills.list({
      profileId: profile.id,
    });
    expect(skills).toHaveLength(1);
  });

  test<CustomTestContext>("listForConsultation 只返回 enabled 技能且不含模板正文，随发布状态联动", async (context) => {
    const publication = await publishExpert(context);
    const profileId = publication.agentProfileId;
    await context.apiCallers[0].agentSkills.create({
      profileId,
      ...skillInput,
      name: "启用的技能",
    });
    const { skill: disabled } = await context.apiCallers[0].agentSkills.create({
      profileId,
      ...skillInput,
      name: "禁用的技能",
    });
    await context.apiCallers[0].agentSkills.update({
      id: disabled.id,
      ...skillInput,
      name: "禁用的技能",
      enabled: false,
    });

    // 咨询者视角：只有启用技能，字段仅 id/name/description/paramsSchema/toolGrant
    // （P3 表单渲染 + P4 授权标识用；不含模板正文）
    const { skills } =
      await context.apiCallers[1].agentSkills.listForConsultation({
        publicationId: publication.id,
      });
    expect(skills.map((s) => s.name)).toEqual(["启用的技能"]);
    expect(Object.keys(skills[0]).sort()).toEqual([
      "description",
      "id",
      "name",
      "paramsSchema",
      "toolGrant",
    ]);

    // 不存在的发布 → 空列表
    expect(
      (
        await context.apiCallers[1].agentSkills.listForConsultation({
          publicationId: "nonexistent",
        })
      ).skills,
    ).toEqual([]);

    // delisting 缓冲期内仍可选用（已有会话继续服务）
    await context.apiCallers[0].agentPublications.delist({
      id: publication.id,
    });
    expect(
      (
        await context.apiCallers[1].agentSkills.listForConsultation({
          publicationId: publication.id,
        })
      ).skills.map((s) => s.name),
    ).toEqual(["启用的技能"]);

    // 彻底下架（delisted）后失效
    await context.db
      .update(agentPublications)
      .set({ status: "delisted" })
      .where(eq(agentPublications.id, publication.id));
    expect(
      (
        await context.apiCallers[1].agentSkills.listForConsultation({
          publicationId: publication.id,
        })
      ).skills,
    ).toEqual([]);
  });

  test<CustomTestContext>("删除档案时级联删除其技能", async (context) => {
    const profile = await createProfile(context.apiCallers[0]);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: profile.id,
      ...skillInput,
    });

    await context.db
      .delete(agentProfiles)
      .where(eq(agentProfiles.id, profile.id));
    const remaining = await context.db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.id, skill.id));
    expect(remaining).toHaveLength(0);
  });
});

describe("Agent Skills P2（知识范围 / 导入导出 / 使用统计）", () => {
  test<CustomTestContext>("技能可绑定 knowledgeScope 并随 list 返回", async (context) => {
    const tag = await context.apiCallers[0].tags.create({ name: "财报" });
    const profile = await createProfile(context.apiCallers[0]);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: profile.id,
      ...skillInput,
      knowledgeScope: { tagIds: [tag.id], listIds: [] },
    });
    expect(skill.knowledgeScope).toEqual({
      tagIds: [tag.id],
      listIds: [],
    });

    const { skills } = await context.apiCallers[0].agentSkills.list({
      profileId: profile.id,
    });
    expect(skills[0].knowledgeScope?.tagIds).toEqual([tag.id]);
    expect(skills[0].usageCount).toBe(0);
  });

  test<CustomTestContext>("exportSkill 脱敏导出（无内部 id，scope 以名称迁移）；importSkill 跨用户按名称重匹配", async (context) => {
    // 专家（用户0）建带标签 scope 的技能
    const tag = await context.apiCallers[0].tags.create({ name: "财报" });
    const profile = await createProfile(context.apiCallers[0]);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: profile.id,
      ...skillInput,
      knowledgeScope: { tagIds: [tag.id], listIds: [] },
    });

    // 非本人技能不可导出
    await expect(
      context.apiCallers[1].agentSkills.exportSkill({ id: skill.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const { asset } = await context.apiCallers[0].agentSkills.exportSkill({
      id: skill.id,
    });
    expect(asset.version).toBe(1);
    expect(asset.name).toBe("深度阅读分析");
    expect(asset.knowledgeScope).toEqual({
      tagNames: ["财报"],
      listNames: [],
    });
    // 不携带任何内部 id
    expect(JSON.stringify(asset)).not.toContain(skill.id);
    expect(JSON.stringify(asset)).not.toContain(tag.id);

    // 咨询者（用户1）名下建同名标签 + 一个不同名的清单（用于验证不匹配丢弃）
    const sameTag = await context.apiCallers[1].tags.create({ name: "财报" });
    const otherProfile = await createProfile(context.apiCallers[1], {
      name: "咨询者的档案",
    });
    const { skill: imported } =
      await context.apiCallers[1].agentSkills.importSkill({
        profileId: otherProfile.id,
        asset,
      });
    // 名称精确匹配 → scope 重匹配到咨询者自己的同名标签
    expect(imported.knowledgeScope).toEqual({
      tagIds: [sameTag.id],
      listIds: [],
    });
    expect(imported.userId).not.toBe(skill.userId);

    // 完全无同名标签的用户导入 → scope 置空但技能本身可用
    const { skill: noScopeImport } =
      await context.apiCallers[1].agentSkills.importSkill({
        profileId: otherProfile.id,
        asset: {
          ...asset,
          knowledgeScope: { tagNames: ["不存在的标签"], listNames: [] },
        },
      });
    expect(noScopeImport.knowledgeScope).toBeNull();

    // 导入到他人档案 → NOT_FOUND
    await expect(
      context.apiCallers[1].agentSkills.importSkill({
        profileId: profile.id,
        asset,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test<CustomTestContext>("usageCount 聚合：记账带 skillId 后技能列表可见调用次数", async (context) => {
    const publication = await publishExpert(context);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: publication.agentProfileId,
      ...skillInput,
    });

    // 直接调记账函数（绕过 sendMessage 的 LLM 链路）记两笔带 skillId
    const { recordConsultationUsage } = await import("./agentPublications");
    const [consultee] = await context.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "test2@test.com"));
    const session = {
      id: "fake-session-for-usage",
      userId: consultee.id,
      publicationId: publication.id,
    };
    // chatSessions FK：sessionId 引用真实会话表，造一条最小会话
    await context.db.insert(chatSessions).values({
      id: session.id,
      userId: consultee.id,
      title: "usage 测试会话",
    });
    await recordConsultationUsage(context.db, session, skill.id);
    await recordConsultationUsage(context.db, session, skill.id);
    // 不带技能的一笔不计入
    await recordConsultationUsage(context.db, session, null);

    const { skills } = await context.apiCallers[0].agentSkills.list({
      profileId: publication.agentProfileId,
    });
    expect(skills.find((s) => s.id === skill.id)?.usageCount).toBe(2);
  });
});

describe("Agent Skills P3（参数化）", () => {
  const paramsSchema = [
    {
      name: "topic",
      label: "分析对象",
      type: "string" as const,
      required: true,
    },
    {
      name: "depth",
      label: "分析深度",
      type: "enum" as const,
      options: ["概览", "深读"],
      default: "概览",
    },
  ];

  test<CustomTestContext>("paramsSchema 落库并随 list / listForConsultation 返回；非法定义被 zod 拦截", async (context) => {
    const publication = await publishExpert(context);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: publication.agentProfileId,
      ...skillInput,
      paramsSchema,
    });
    expect(skill.paramsSchema).toEqual(paramsSchema);

    const { skills } = await context.apiCallers[0].agentSkills.list({
      profileId: publication.agentProfileId,
    });
    expect(skills.find((s) => s.id === skill.id)?.paramsSchema).toEqual(
      paramsSchema,
    );

    // 咨询端返回参数定义（渲染填参表单）
    const consultation =
      await context.apiCallers[1].agentSkills.listForConsultation({
        publicationId: publication.id,
      });
    expect(
      consultation.skills.find((s) => s.id === skill.id)?.paramsSchema,
    ).toEqual(paramsSchema);

    // enum 缺 options → 拦截
    await expect(
      context.apiCallers[0].agentSkills.create({
        profileId: publication.agentProfileId,
        ...skillInput,
        name: "坏定义",
        paramsSchema: [{ name: "bad", label: "坏", type: "enum" }],
      }),
    ).rejects.toThrow();

    // name 重复 → 拦截
    await expect(
      context.apiCallers[0].agentSkills.create({
        profileId: publication.agentProfileId,
        ...skillInput,
        name: "重名参数",
        paramsSchema: [
          { name: "dup", label: "A", type: "string" },
          { name: "dup", label: "B", type: "string" },
        ],
      }),
    ).rejects.toThrow();

    // 参数名不合法（含空格）→ 拦截
    await expect(
      context.apiCallers[0].agentSkills.create({
        profileId: publication.agentProfileId,
        ...skillInput,
        name: "非法参数名",
        paramsSchema: [{ name: "bad name", label: "带空格", type: "string" }],
      }),
    ).rejects.toThrow();
  });

  test<CustomTestContext>("exportSkill / importSkill 携带 paramsSchema", async (context) => {
    const profile = await createProfile(context.apiCallers[0]);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: profile.id,
      ...skillInput,
      paramsSchema,
    });
    const { asset } = await context.apiCallers[0].agentSkills.exportSkill({
      id: skill.id,
    });
    expect(asset.paramsSchema).toEqual(paramsSchema);

    const otherProfile = await createProfile(context.apiCallers[1], {
      name: "导入者的档案",
    });
    const { skill: imported } =
      await context.apiCallers[1].agentSkills.importSkill({
        profileId: otherProfile.id,
        asset,
      });
    expect(imported.paramsSchema).toEqual(paramsSchema);
  });
});

describe("Agent Skills P4（工具执行型）", () => {
  const toolGrant: SkillToolGrant = {
    tools: ["save_widget", "update_widget"],
    confirmRequired: true,
  };

  test<CustomTestContext>("toolGrant 落库并随 list / listForConsultation 返回；白名单外工具名被 zod 拦截", async (context) => {
    const publication = await publishExpert(context);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: publication.agentProfileId,
      ...skillInput,
      toolGrant,
    });
    expect(skill.toolGrant).toEqual(toolGrant);

    const { skills } = await context.apiCallers[0].agentSkills.list({
      profileId: publication.agentProfileId,
    });
    expect(skills.find((s) => s.id === skill.id)?.toolGrant).toEqual(toolGrant);

    // 咨询端返回授权声明（渲染授权确认）
    const consultation =
      await context.apiCallers[1].agentSkills.listForConsultation({
        publicationId: publication.id,
      });
    expect(
      consultation.skills.find((s) => s.id === skill.id)?.toolGrant,
    ).toEqual(toolGrant);

    // 白名单外工具名（中危写）→ 服务端硬校验拦截
    await expect(
      context.apiCallers[0].agentSkills.create({
        profileId: publication.agentProfileId,
        ...skillInput,
        name: "越权技能",
        // 类型断言绕过 TS：故意传白名单外的值，验证运行时 zod 拦截
        toolGrant: {
          tools: ["create_bookmark"] as unknown as SkillToolGrant["tools"],
          confirmRequired: true,
        },
      }),
    ).rejects.toThrow();

    // 空工具数组 → 拦截（min(1)）
    await expect(
      context.apiCallers[0].agentSkills.create({
        profileId: publication.agentProfileId,
        ...skillInput,
        name: "空授权技能",
        toolGrant: { tools: [], confirmRequired: true },
      }),
    ).rejects.toThrow();

    // 无 toolGrant 技能 → null（纯提示词型，P1-P3 行为不变）
    const { skill: plain } = await context.apiCallers[0].agentSkills.create({
      profileId: publication.agentProfileId,
      ...skillInput,
      name: "纯模板技能",
    });
    expect(plain.toolGrant).toBeNull();
  });

  test<CustomTestContext>("exportSkill / importSkill 携带 toolGrant；更新可清除授权", async (context) => {
    const profile = await createProfile(context.apiCallers[0]);
    const { skill } = await context.apiCallers[0].agentSkills.create({
      profileId: profile.id,
      ...skillInput,
      toolGrant,
    });
    const { asset } = await context.apiCallers[0].agentSkills.exportSkill({
      id: skill.id,
    });
    expect(asset.toolGrant).toEqual(toolGrant);

    const otherProfile = await createProfile(context.apiCallers[1], {
      name: "导入者的档案",
    });
    const { skill: imported } =
      await context.apiCallers[1].agentSkills.importSkill({
        profileId: otherProfile.id,
        asset,
      });
    expect(imported.toolGrant).toEqual(toolGrant);

    // 更新为 null 清除授权（toolGrant 缺省 → null）
    const { skill: cleared } = await context.apiCallers[0].agentSkills.update({
      id: skill.id,
      ...skillInput,
    });
    expect(cleared.toolGrant).toBeNull();
  });
});
