// Temp script: Phase 2 batch replace (page titles + i18n values).
// Only touches: `| Karakeep` title suffix in app pages, and capital-K "Karakeep" in translation.json values.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

// 1. Page titles: files containing `| Karakeep` under apps/web/app
const titleFiles = execSync(
  `git -C "${ROOT}" grep -l "| Karakeep" -- apps/web/app`,
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean);

let titleCount = 0;
for (const rel of titleFiles) {
  const file = resolve(ROOT, rel);
  let text = readFileSync(file, "utf8");
  const before = text;
  text = text.replaceAll("| Karakeep`", "| Saiye`");
  if (text !== before) {
    writeFileSync(file, text);
    const n = (before.match(/\| Karakeep`/g) || []).length;
    titleCount += n;
    console.log(`TITLE ${rel} (${n})`);
  }
}

// 2. i18n: replace whole-word capital "Karakeep" -> "Saiye" (keys are lowercase, so values only)
const i18nFiles = execSync(
  `git -C "${ROOT}" grep -l "Karakeep" -- apps/web/lib/i18n/locales`,
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean);

let i18nCount = 0;
for (const rel of i18nFiles) {
  const file = resolve(ROOT, rel);
  const before = readFileSync(file, "utf8");
  const after = before.replace(/\bKarakeep\b/g, "Saiye");
  if (after !== before) {
    writeFileSync(file, after);
    const n = (before.match(/\bKarakeep\b/g) || []).length;
    i18nCount += n;
    console.log(`I18N ${rel} (${n})`);
  }
}

console.log(`\nDone: ${titleCount} title refs in ${titleFiles.length} files, ${i18nCount} i18n refs in ${i18nFiles.length} files`);
