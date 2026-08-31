// 临时脚本：扫描多个包产物中的全部裸 import 包名（含 workspace 里已装的对照）
const fs = require("fs");
const path = require("path");

const files = [
  "f:/karakeep/karakeep/node_modules/@drawnix/drawnix/index.mjs",
  "f:/karakeep/karakeep/node_modules/@plait-board/react-board/index.mjs",
];

// web 已声明的依赖
const webPkg = JSON.parse(
  fs.readFileSync("f:/karakeep/karakeep/apps/web/package.json", "utf8"),
);
const declared = new Set([
  ...Object.keys(webPkg.dependencies || {}),
  ...Object.keys(webPkg.devDependencies || {}),
]);
// 加上 react 等隐式可用的
["react", "react-dom"].forEach((r) => declared.add(r));

const re =
  /(?:from\s*['"]([^'"]+)['"])|(?:import\s*['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"])/g;

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const pkgs = new Set();
  let m;
  const localRe = new RegExp(re.source, "g");
  while ((m = localRe.exec(src))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    const parts = spec.split("/");
    const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    pkgs.add(pkg);
  }
  console.log(`\n=== ${path.basename(path.dirname(f))}/${path.basename(f)} ===`);
  console.log(
    [...pkgs]
      .sort()
      .map((p) => (declared.has(p) ? `  [ok] ${p}` : `  [MISSING] ${p}`))
      .join("\n"),
  );
}
