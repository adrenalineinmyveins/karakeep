// Phase 7: docs directory brand replacement (Karakeep -> Saiye)
// Usage: node .rebrand/phase7-docs.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");

// Skip entirely: upstream factual content (third-party projects, upstream cloud/pikapods/discord, historical migration)
const SKIP = new Set([
  "docs/07-community/01-community-projects.md",
  "docs/07-community/02-community-channels.md",
  "docs/02-installation/09-cloud-hosting.md",
  "docs/02-installation/10-pikapods.md",
  "docs/06-administration/08-hoarder-to-karakeep-migration.md",
  "docs/01-getting-started/01-intro.md", // manual edits
]);

// Protected strings (upstream services / store listings / AUR packages kept factual)
const PROTECT = [
  "adrenalineinmyveins/karakeep",
  "try.karakeep.app",
  "demo@karakeep.app",
  "cloud.karakeep.app",
  "discord.gg/NrgeYywsFh",
  "aur.archlinux.org/packages/karakeep",
  "paru -S karakeep-cli",
  "paru -S karakeep",
  "paru -R hoarder",
  "kgcjekpmcjjogibpjebkhaanilehneje", // chrome store id URL
  "addons.mozilla.org/en-US/firefox/addon/karakeep",
  "apps.apple.com/us/app/karakeep-app",
  "apps.apple.com/gb/app/karakeep-app",
  "play.google.com/store/apps/details?id=app.hoarder.hoardermobile",
];

const REPLACEMENTS = [
  ["docs.karakeep.app", "docs.saiye.app"],
  ["karakeep-app/karakeep", "adrenalineinmyveins/karakeep"],
  ["KARAKEEP_", "SAIYE_"],
  ["karakeep-linux.sh", "saije-linux.sh"],
  ["Karakeep", "Saiye"],
  ["karakeep", "saiye"],
];

const PH = "\u0000P";
function fix(content) {
  let out = content;
  PROTECT.forEach((p, i) => {
    out = out.split(p).join(`${PH}${i}\u0000`);
  });
  for (const [from, to] of REPLACEMENTS) {
    out = out.split(from).join(to);
  }
  PROTECT.forEach((p, i) => {
    out = out.split(`${PH}${i}\u0000`).join(p);
  });
  return out;
}

const changed = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(DOCS, full).replaceAll("\\", "/");
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(md|mdx|ts|tsx|json|txt|yml)$/.test(name)) continue;
    if (SKIP.has(rel)) continue;
    const content = readFileSync(full, "utf8");
    const out = fix(content);
    if (out !== content) {
      writeFileSync(full, out);
      changed.push(rel);
    }
  }
}
walk(DOCS);
console.log(`changed ${changed.length} files`);
