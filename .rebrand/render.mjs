// Temp script: render saije brand SVGs to all icon sizes via Chrome headless.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BROWSER = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = resolve(import.meta.dirname, "profile-chrome-render");

// [svgFile, w, h, outRelPath, extraCss]
const jobs = [
  // web
  ["mark.svg", 16, 16, "apps/web/public/icons/logo-16.png"],
  ["mark.svg", 48, 48, "apps/web/public/icons/logo-48.png"],
  ["mark.svg", 128, 128, "apps/web/public/icons/logo-128.png"],
  ["mark.svg", 192, 192, "apps/web/public/icons/logo-192.png"],
  ["mark.svg", 512, 512, "apps/web/public/icons/logo-512.png"],
  ["mark.svg", 512, 512, "apps/web/app/icon.png"],
  ["mark.svg", 180, 180, "apps/web/app/apple-icon.png"],
  // browser extension
  ["mark.svg", 16, 16, "apps/browser-extension/public/logo-16.png"],
  ["mark.svg", 48, 48, "apps/browser-extension/public/logo-48.png"],
  ["mark.svg", 128, 128, "apps/browser-extension/public/logo-128.png"],
  ["mark.svg", 512, 512, "apps/browser-extension/public/logo.png"],
  ["glyph-white.svg", 16, 16, "apps/browser-extension/public/logo-16-darkmode.png"],
  ["glyph-white.svg", 48, 48, "apps/browser-extension/public/logo-48-darkmode.png"],
  ["glyph-white.svg", 128, 128, "apps/browser-extension/public/logo-128-darkmode.png"],
  ["full.svg", 700, 200, "apps/browser-extension/public/logo-full.png", "text{fill:#18181B}"],
  ["full.svg", 700, 200, "apps/browser-extension/public/logo-full-white.png", "text{fill:#FAFAFA}"],
  // mobile
  ["mark.svg", 1024, 1024, "apps/mobile/assets/icon.png"],
  ["mark-gray.svg", 1024, 1024, "apps/mobile/assets/icon-tinted.png"],
  ["adaptive.svg", 1024, 1024, "apps/mobile/assets/adaptive-icon.png"],
  ["splash-light.svg", 1024, 2048, "apps/mobile/assets/splash.png"],
  ["splash-dark.svg", 1024, 2048, "apps/mobile/assets/splash-white.png"],
  // desktop
  ["mark.svg", 1024, 1024, "apps/desktop/src-tauri/app-icon.png"],
  ["mark.svg", 512, 512, "apps/desktop/src-tauri/icons/icon.png"],
  ["mark.svg", 32, 32, "apps/desktop/src-tauri/icons/32x32.png"],
  ["mark.svg", 64, 64, "apps/desktop/src-tauri/icons/64x64.png"],
  ["mark.svg", 128, 128, "apps/desktop/src-tauri/icons/128x128.png"],
  ["mark.svg", 256, 256, "apps/desktop/src-tauri/icons/128x128@2x.png"],
  ["mark.svg", 30, 30, "apps/desktop/src-tauri/icons/Square30x30Logo.png"],
  ["mark.svg", 44, 44, "apps/desktop/src-tauri/icons/Square44x44Logo.png"],
  ["mark.svg", 70, 70, "apps/desktop/src-tauri/icons/Square70x70Logo.png"],
  ["mark.svg", 71, 71, "apps/desktop/src-tauri/icons/Square71x71Logo.png"],
  ["mark.svg", 89, 89, "apps/desktop/src-tauri/icons/Square89x89Logo.png"],
  ["mark.svg", 107, 107, "apps/desktop/src-tauri/icons/Square107x107Logo.png"],
  ["mark.svg", 142, 142, "apps/desktop/src-tauri/icons/Square142x142Logo.png"],
  ["mark.svg", 150, 150, "apps/desktop/src-tauri/icons/Square150x150Logo.png"],
  ["mark.svg", 284, 284, "apps/desktop/src-tauri/icons/Square284x284Logo.png"],
  ["mark.svg", 310, 310, "apps/desktop/src-tauri/icons/Square310x310Logo.png"],
  ["mark.svg", 50, 50, "apps/desktop/src-tauri/icons/StoreLogo.png"],
  // desktop android mipmaps (launcher + foreground)
  ["mark.svg", 48, 48, "apps/desktop/src-tauri/icons/android/mipmap-mdpi/ic_launcher.png"],
  ["mark.svg", 48, 48, "apps/desktop/src-tauri/icons/android/mipmap-mdpi/ic_launcher_round.png"],
  ["mark.svg", 72, 72, "apps/desktop/src-tauri/icons/android/mipmap-hdpi/ic_launcher.png"],
  ["mark.svg", 72, 72, "apps/desktop/src-tauri/icons/android/mipmap-hdpi/ic_launcher_round.png"],
  ["mark.svg", 96, 96, "apps/desktop/src-tauri/icons/android/mipmap-xhdpi/ic_launcher.png"],
  ["mark.svg", 96, 96, "apps/desktop/src-tauri/icons/android/mipmap-xhdpi/ic_launcher_round.png"],
  ["mark.svg", 144, 144, "apps/desktop/src-tauri/icons/android/mipmap-xxhdpi/ic_launcher.png"],
  ["mark.svg", 144, 144, "apps/desktop/src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_round.png"],
  ["mark.svg", 192, 192, "apps/desktop/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png"],
  ["mark.svg", 192, 192, "apps/desktop/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_round.png"],
  ["adaptive.svg", 108, 108, "apps/desktop/src-tauri/icons/android/mipmap-mdpi/ic_launcher_foreground.png"],
  ["adaptive.svg", 162, 162, "apps/desktop/src-tauri/icons/android/mipmap-hdpi/ic_launcher_foreground.png"],
  ["adaptive.svg", 216, 216, "apps/desktop/src-tauri/icons/android/mipmap-xhdpi/ic_launcher_foreground.png"],
  ["adaptive.svg", 324, 324, "apps/desktop/src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_foreground.png"],
  ["adaptive.svg", 432, 432, "apps/desktop/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_foreground.png"],
  // desktop iOS AppIcons (px = logical * scale, parsed from filename)
  ["mark.svg", 20, 20, "apps/desktop/src-tauri/icons/ios/AppIcon-20x20@1x.png"],
  ["mark.svg", 40, 40, "apps/desktop/src-tauri/icons/ios/AppIcon-20x20@2x.png"],
  ["mark.svg", 60, 60, "apps/desktop/src-tauri/icons/ios/AppIcon-20x20@3x.png"],
  ["mark.svg", 29, 29, "apps/desktop/src-tauri/icons/ios/AppIcon-29x29@1x.png"],
  ["mark.svg", 58, 58, "apps/desktop/src-tauri/icons/ios/AppIcon-29x29@2x.png"],
  ["mark.svg", 87, 87, "apps/desktop/src-tauri/icons/ios/AppIcon-29x29@3x.png"],
  ["mark.svg", 40, 40, "apps/desktop/src-tauri/icons/ios/AppIcon-40x40@1x.png"],
  ["mark.svg", 80, 80, "apps/desktop/src-tauri/icons/ios/AppIcon-40x40@2x.png"],
  ["mark.svg", 80, 80, "apps/desktop/src-tauri/icons/ios/AppIcon-40x40@2x-1.png"],
  ["mark.svg", 120, 120, "apps/desktop/src-tauri/icons/ios/AppIcon-40x40@3x.png"],
  ["mark.svg", 120, 120, "apps/desktop/src-tauri/icons/ios/AppIcon-60x60@2x.png"],
  ["mark.svg", 180, 180, "apps/desktop/src-tauri/icons/ios/AppIcon-60x60@3x.png"],
  ["mark.svg", 76, 76, "apps/desktop/src-tauri/icons/ios/AppIcon-76x76@1x.png"],
  ["mark.svg", 152, 152, "apps/desktop/src-tauri/icons/ios/AppIcon-76x76@2x.png"],
  ["mark.svg", 167, 167, "apps/desktop/src-tauri/icons/ios/AppIcon-83.5x83.5@2x.png"],
  ["mark.svg", 1024, 1024, "apps/desktop/src-tauri/icons/ios/AppIcon-512@2x.png"],
  // temps for ico packaging
  ["mark.svg", 32, 32, ".rebrand/tmp-32.png"],
  ["mark.svg", 48, 48, ".rebrand/tmp-48.png"],
];

function pngDims(file) {
  const buf = readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

let ok = 0;
let fail = 0;
jobs.forEach(([svgFile, w, h, outRel, extraCss], i) => {
  const out = resolve(ROOT, outRel);
  mkdirSync(dirname(out), { recursive: true });
  const svg = readFileSync(resolve(import.meta.dirname, svgFile), "utf8");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:${w}px;height:${h}px;overflow:hidden;background:transparent}svg{display:block;width:${w}px;height:${h}px}${extraCss ? ";" + extraCss : ""}</style></head><body>${svg}</body></html>`;
  const htmlPath = resolve(import.meta.dirname, `tmp-render-${i}.html`);
  writeFileSync(htmlPath, html);
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${PROFILE}`,
    `--screenshot=${out}`,
    `--window-size=${w},${h}`,
    "--default-background-color=00000000",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--virtual-time-budget=3000",
    `file:///${htmlPath.replace(/\\/g, "/")}`,
  ];
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    try {
      execFileSync(BROWSER, args, { timeout: 60000, stdio: "ignore" });
      const dims = pngDims(out);
      if (dims.w === w && dims.h === h) {
        done = true;
      } else {
        console.error(`RETRY(attempt ${attempt}) ${outRel}: got ${dims.w}x${dims.h}, want ${w}x${h}`);
      }
    } catch (e) {
      console.error(`RETRY(attempt ${attempt}) ${outRel}: ${e.message.split("\n")[0]}`);
    }
  }
  if (done) {
    ok++;
    console.log(`OK  ${w}x${h}  ${outRel}`);
  } else {
    fail++;
    console.error(`FAIL ${outRel}`);
  }
  try { rmSync(htmlPath); } catch {}
});
console.log(`\nDone: ${ok} ok, ${fail} failed`);
