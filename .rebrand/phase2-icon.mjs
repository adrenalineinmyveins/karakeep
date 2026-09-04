// Temp script: update KarakeepIcon -> SaiyeIcon references.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const files = [
  "apps/web/components/public/lists/PublicListHeader.tsx",
  "apps/web/components/dashboard/header/Header.tsx",
  "apps/web/app/signup/page.tsx",
  "apps/web/app/signin/page.tsx",
  "apps/web/app/invite/[token]/page.tsx",
  "apps/web/app/forgot-password/page.tsx",
  "apps/web/app/reset-password/page.tsx",
];
for (const rel of files) {
  const file = resolve(ROOT, rel);
  const before = readFileSync(file, "utf8");
  const after = before
    .replaceAll("@/components/KarakeepIcon", "@/components/SaiyeIcon")
    .replaceAll("KarakeepLogo", "SaiyeLogo");
  if (after === before) {
    console.log(`SKIP (no match) ${rel}`);
    continue;
  }
  writeFileSync(file, after);
  console.log(`UPDATED ${rel}`);
}
