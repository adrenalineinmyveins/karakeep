// Phase 5 身份层机械替换。跑完即删。
// A: @karakeep/ -> @saiye/   B: KARAKEEP_ -> SAIYE_
// C: karakeep-app/karakeep -> adrenalineinmyveins/karakeep
// D: SDK/类型名  E: 生成文件名
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = process.cwd();
const TEXT_EXT =
  /\.(ts|tsx|js|mjs|cjs|jsx|json|md|mdx|ya?ml|toml|css|scss|html|sh|txt|astro|rs|env.*)$/i;

const REPLACEMENTS = [
  ["@karakeep/", "@saiye/"],
  ["KARAKEEP_", "SAIYE_"],
  ["karakeep-app/karakeep", "adrenalineinmyveins/karakeep"],
  ["createKarakeepClient", "createSaiyeClient"],
  ["createHoarderClient", "createSaiyeClient"],
  ["KarakeepAPISchemas", "SaiyeAPISchemas"],
  ["KarakeepDBTransaction", "SaiyeDBTransaction"],
  ["karakeep-api.d.ts", "saiye-api.d.ts"],
  ["karakeep-openapi-spec.json", "saiye-openapi-spec.json"],
];

const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(
    (f) =>
      f &&
      !f.startsWith(".rebrand/") &&
      f !== "pnpm-lock.yaml" &&
      TEXT_EXT.test(f),
  );

const stats = new Map();
let touched = 0;
for (const rel of files) {
  let src;
  try {
    src = readFileSync(rel, "utf8");
  } catch {
    continue; // 二进制等
  }
  let next = src;
  let n = 0;
  for (const [from, to] of REPLACEMENTS) {
    const c = next.split(from).length - 1;
    if (c > 0) {
      n += c;
      next = next.split(from).join(to);
      stats.set(`${from} -> ${to}`, (stats.get(`${from} -> ${to}`) ?? 0) + c);
    }
  }
  if (n > 0) {
    writeFileSync(rel, next);
    touched++;
  }
}
console.log(`处理 ${files.length} 个跟踪文件，改动 ${touched} 个`);
for (const [k, v] of stats) console.log(`${k}: ${v}`);
