// Phase 6: residual brand cleanup (metrics/k8s/email/cli/mcp/e2e/tooling)
// Usage: node .rebrand/phase6-cleanup.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Global protections (never touched by brand replacements)
const GLOBAL_PROTECT = [
  "adrenalineinmyveins/karakeep", // repo/image URLs keep original repo name
  "docs.karakeep.app", // upstream docs links kept
];
const PLACEHOLDER = "\u0000PROTECT";

function fix(content, replacements, protect = []) {
  let out = content;
  const allProtect = [...GLOBAL_PROTECT, ...protect];
  allProtect.forEach((p, i) => {
    out = out.split(p).join(`${PLACEHOLDER}${i}\u0000`);
  });
  for (const [from, to] of replacements) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
  }
  allProtect.forEach((p, i) => {
    out = out.split(`${PLACEHOLDER}${i}\u0000`).join(p);
  });
  return out;
}

const G = {
  lower: [
    ["Karakeep", "Saiye"],
    ["karakeep", "saiye"],
  ],
};

// [relativePath, replacements, extraProtect]
const JOBS = [
  // metrics & observability
  ["packages/api/routes/metrics.ts", [["__karakeepApiPrometheus", "__saiyeApiPrometheus"], ["karakeep_", "saiye_"]]],
  ["packages/trpc/stats.ts", [["karakeep_", "saiye_"]]],
  ["apps/workers/metrics.ts", [["karakeep_", "saiye_"]]],
  ["apps/workers/workers/importWorker.ts", [["karakeep_", "saiye_"]]],
  ["packages/trpc/routers/subscriptions.test.ts", [["test.karakeep.com", "test.saiye.com"]]],

  // workers
  ["apps/workers/workers/backupWorker.ts", [["karakeep-backup-", "saiye-backup-"]]],
  ["apps/workers/workers/crawler/browser.ts", [["karakeep_adblocker.bin", "saiye_adblocker.bin"]]],
  ["apps/workers/scripts/crawlAdhoc.ts", [["karakeep-adhoc-", "saiye-adhoc-"]]],
  ["apps/workers/metascraper-plugins/metascraper-reddit.ts", [["Karakeep", "Saiye"]]],
  ["apps/workers/tsdown.config.ts", [["/^@karakeep\\//", "/^@saiye\\//"]]],
  ["tooling/prettier/index.js", [["^@karakeep", "^@saiye"]]],

  // api / trpc display
  ["packages/api/utils/rss.ts", [["generator: \"Karakeep\"", "generator: \"Saiye\""]]],
  ["packages/api/utils/upload.ts", [["karakeep-upload-", "saiye-upload-"]]],
  ["packages/trpc/email.ts", G.lower],
  ["packages/trpc/routers/invites.ts", [["A Karakeep admin", "A Saiye admin"]]],
  ["packages/trpc/lib/agent/orchestrator.ts", [["Karakeep", "Saiye"]]],

  // shared internals
  ["packages/shared/plugins.ts", [["__karakeep_plugins_providers__", "__saiye_plugins_providers__"]]],
  ["packages/shared-server/src/plugins.ts", [["__karakeep_plugins_loader_state__", "__saiye_plugins_loader_state__"]]],
  ["packages/shared-server/src/eventLogger.ts", [["__karakeepEventLogger", "__saiyeEventLogger"]]],
  ["packages/shared/utils/redirectUrl.ts", [["karakeep://", "saiye://"]]],
  ["packages/shared/utils/redirectUrl.test.ts", [["karakeep://", "saiye://"]]],
  ["packages/shared-react/hooks/search-history.ts", [["karakeep_search_history", "saiye_search_history"]]],

  // import/export source enum
  ["packages/shared/import-export/parsers.ts", [["\"karakeep\"", "\"saiye\""], ["parseKarakeepBookmarkFile", "parseSaiyeBookmarkFile"], ["in karakeep", "in Saiye"]]],
  ["packages/shared/import-export/parsers.test.ts", [["\"karakeep\"", "\"saiye\""], ["parseKarakeepBookmarkFile", "parseSaiyeBookmarkFile"]]],
  ["packages/shared/import-export/importer.test.ts", [["karakeep", "saiye"]]],

  // open-api
  [
    "packages/open-api/index.ts",
    [
      ["Karakeep API", "Saiye API"],
      ["Karakeep is a self-hostable", "Saiye is a self-hostable"],
      ["from the Karakeep web UI", "from the Saiye web UI"],
      ["https://try.karakeep.app", "https://try.saiye.app"],
      ["the Karakeep server", "the Saiye server"],
    ],
  ],
  [
    "packages/open-api/saiye-openapi-spec.json",
    [
      ["Karakeep API", "Saiye API"],
      ["Karakeep is a self-hostable", "Saiye is a self-hostable"],
      ["from the Karakeep web UI", "from the Saiye web UI"],
      ["https://try.karakeep.app", "https://try.saiye.app"],
      ["the Karakeep server", "the Saiye server"],
    ],
  ],

  // sdk
  ["packages/sdk/package.json", [["Typescript SDK for Karakeep", "Typescript SDK for Saiye"], ["\"hoarder\",\n    \"karakeep\",\n", "\"saiye\",\n"]]],
  ["packages/sdk/README.md", G.lower],

  // mcp
  ["apps/mcp/package.json", [["MCP server for Karakeep", "MCP server for Saiye"], ["\"hoarder\",\n    \"karakeep\",\n", "\"saiye\",\n"], ["karakeep-mcp", "saiye-mcp"]]],
  ["apps/mcp/README.md", G.lower],
  ["apps/mcp/src/shared.ts", [["Karakeep", "Saiye"], ["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/bookmarks.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/lists.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/tags.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/highlights.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/assets.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/bookmarks.test.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/lists.test.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/tags.test.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/highlights.test.ts", [["karakeepClient", "saiyeClient"]]],
  ["apps/mcp/src/assets.test.ts", [["karakeepClient", "saiyeClient"]]],

  // cli
  ["apps/cli/package.json", [["CLI) for Karakeep", "CLI) for Saiye"], ["\"hoarder\",\n    \"karakeep\",\n", "\"saiye\",\n"], ["\"karakeep\": \"dist/index.mjs\"", "\"saiye\": \"dist/index.mjs\""]]],
  ["apps/cli/src/index.ts", G.lower],
  ["apps/cli/src/lib/config.ts", [["https://cloud.karakeep.app", "http://localhost:3000"], ["\"karakeep\"", "\"saiye\""]]],
  ["apps/cli/src/commands/auth.ts", G.lower],
  ["apps/cli/src/commands/wipe.ts", G.lower],
  ["apps/cli/src/commands/migrate.ts", G.lower],
  ["apps/cli/src/commands/dump.ts", G.lower],

  // skills
  ["skills/SKILL.md", G.lower, ["https://karakeep.app"]],

  // web
  ["apps/web/components/settings/ImportExport.tsx", [["source: \"karakeep\"", "source: \"saiye\""]]],
  ["apps/web/components/dashboard/canvas/plugins/withBookmarkCard.test.tsx", [["Karakeep", "Saiye"]]],

  // patch
  ["patches/@drawnix__drawnix.patch", [["injectedPluginsKarakeep", "injectedPluginsSaiye"]]],

  // docker / kubernetes
  [
    "docker/Dockerfile",
    [
      ["--filter @karakeep/workers", "--filter @saiye/workers"],
      ["github.com/karakeep-app/karakeep", "github.com/adrenalineinmyveins/karakeep"],
      ["karakeep-app/karakeep#2758", "adrenalineinmyveins/karakeep#2758"],
    ],
  ],
  ["kubernetes/namespace.yaml", G.lower],
  ["kubernetes/kustomization.yaml", G.lower],
  ["kubernetes/web-deployment.yaml", G.lower],
  ["kubernetes/web-service.yaml", G.lower],
  ["kubernetes/meilisearch-deployment.yaml", G.lower],
  ["kubernetes/ingress_sample.yaml", G.lower],
  ["start-dev.sh", [["karakeep-meilisearch", "saiye-meilisearch"], ["karakeep-chrome", "saiye-chrome"]]],
  ["saije-linux.sh", G.lower, ["The Karakeep installation script", "karakeep-\"$RELEASE\""]],

  // e2e
  ["packages/e2e_tests/setup/startContainers.ts", [["karakeepPort", "saiyePort"], ["karakeep=", "saiye="]]],
  ["packages/e2e_tests/setup/aimock/inference.json", [["\"karakeep\"", "\"saiye\""], ["Karakeep's", "Saiye's"]]],
  ...[
    "assets", "backups", "bookmarks", "feeds", "highlights", "lists", "public", "rss", "tags", "users",
  ].map((n) => [`packages/e2e_tests/tests/api/${n}.test.ts`, [["karakeepPort", "saiyePort"], ["karakeep-backup", "saiye-backup"], ["\"karakeep\"", "\"saiye\""]]]),
  ...[
    "crawler", "embeddings", "feed", "import", "inference", "video",
  ].map((n) => [`packages/e2e_tests/tests/workers/${n}.test.ts`, [["karakeepPort", "saiyePort"], ["karakeep-backup", "saiye-backup"], ["\"karakeep\"", "\"saiye\""]]]),

  // benchmarks / tools
  ["packages/benchmarks/README.md", G.lower],
  ["packages/benchmarks/src/startContainers.ts", [["Karakeep stack", "Saiye stack"]]],
  ["packages/benchmarks/setup/html/hello.html", [["Karakeep Benchmarks", "Saiye Benchmarks"]]],
  ["tools/seed-snapshot/src/index.ts", [["Karakeep", "Saiye"]]],
  ["tools/compare-models/README.md", [["your-karakeep-instance.com", "your-saiye-instance.com"], ...G.lower]],
  ["tools/compare-models/src/apiClient.ts", [["KarakeepAPIClient", "SaiyeAPIClient"], ...G.lower]],
  ["tools/compare-models/src/index.ts", [["KarakeepAPIClient", "SaiyeAPIClient"], ...G.lower]],

  // landing
  ["apps/landing/package.json", [["--name karakeep-landing", "--name saiye-landing"]]],
  ["apps/landing/public/robots.txt", [["karakeep.app", "saiye.app"]]],
  ["apps/landing/public/sitemap.xml", [["karakeep.app", "saiye.app"]]],

  // top-level docs
  ["CONTRIBUTING.md", [["# Contributing to Karakeep", "# Contributing to Saiye"]]],
  [
    "AGENTS.md",
    [
      ["# Karakeep Project Overview", "# Saiye Project Overview"],
      ["context about the Karakeep project", "context about the Saiye project (based on Karakeep)"],
      ["Karakeep is a monorepo project", "Saiye (based on Karakeep) is a monorepo project"],
      ["saving content to karakeep", "saving content to Saiye"],
      ["communicate with Karakeep", "communicate with Saiye"],
    ],
  ],
];

let changed = 0;
let unchanged = 0;
const missed = [];
for (const [rel, replacements, protect = []] of JOBS) {
  const file = path.join(ROOT, rel);
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    missed.push(`${rel} (read failed)`);
    continue;
  }
  const out = fix(content, replacements, protect);
  if (out !== content) {
    writeFileSync(file, out);
    changed++;
  } else {
    unchanged++;
  }
}
console.log(`changed=${changed} unchanged=${unchanged}`);
if (missed.length) console.log("missed:\n" + missed.join("\n"));
