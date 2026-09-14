import { describe, expect, test } from "vitest";

import en from "./locales/en/translation.json";
import enUS from "./locales/en_US/translation.json";
import zh from "./locales/zh/translation.json";

/**
 * i18n 词条完整性回归测试：
 *
 * 1. 全部词条键在三种语言（en / en_US / zh）完全一致——任何区域新增
 *    词条漏翻某种语言都会被抓住（历史上 about / agent_profiles / admin
 *    区曾长期漂移，现已补齐并以此测试守护）；
 * 2. widgets.perm_* 恰好覆盖全部 9 个权限
 *    （bookmarks / tags / lists × read / write / delete），
 *    与 InstallConsentDialog 的 permissionLabelKey 映射一一对应。
 */

const translations = { en, en_US: enUS, zh } as const;
type Locale = keyof typeof translations;

// 展平嵌套词条对象为点分键："canvas.updated_at" 等
function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? flattenKeys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

const allKeys: Record<Locale, string[]> = Object.fromEntries(
  Object.entries(translations).map(([locale, dict]) => [
    locale,
    flattenKeys(dict).sort(),
  ]),
) as Record<Locale, string[]>;

describe("i18n 词条完整性", () => {
  test("全部词条键在三语言完全一致", () => {
    for (const locale of ["en_US", "zh"] as const) {
      const missing = allKeys.en.filter(
        (key) => !allKeys[locale].includes(key),
      );
      const extra = allKeys[locale].filter((key) => !allKeys.en.includes(key));
      expect({ missing, extra }, `${locale} 与 en 存在词条漂移`).toEqual({
        missing: [],
        extra: [],
      });
    }
  });

  test("widgets.perm_* 覆盖全部 9 个权限且三语言齐全", () => {
    const permissions = ["bookmarks", "tags", "lists"].flatMap((resource) =>
      ["read", "write", "delete"].map(
        (action) => `widgets.perm_${resource}_${action}`,
      ),
    );
    for (const locale of ["en", "en_US", "zh"] as const) {
      for (const key of permissions) {
        expect(allKeys[locale], `${locale} 缺少 ${key}`).toContain(key);
      }
    }
  });
});
