// Temp script: build .ico files (PNG-embedded ICO) from rendered PNGs.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function buildIco(pngPaths, outPath) {
  const pngs = pngPaths.map((p) => readFileSync(p));
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const entries = [];
  for (const buf of pngs) {
    // PNG IHDR: width at byte 16, height at byte 20
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(w >= 256 ? 0 : w, 0);
    entry.writeUInt8(h >= 256 ? 0 : h, 1);
    entry.writeUInt8(0, 2); // colors
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(entry);
  }
  const ico = Buffer.concat([header, ...entries, ...pngs]);
  writeFileSync(outPath, ico);
  console.log(`OK ${outPath} (${count} images)`);
}

const dir = resolve(import.meta.dirname);
const root = resolve(dir, "..");

// web favicon: 16/32/48
buildIco(
  [
    resolve(root, "apps/web/public/icons/logo-16.png"),
    resolve(dir, "tmp-32.png"),
    resolve(dir, "tmp-48.png"),
  ],
  resolve(root, "apps/web/app/favicon.ico"),
);

// desktop icon.ico: 16/32/48/64/128/256
const dIcons = resolve(root, "apps/desktop/src-tauri/icons");
buildIco(
  [
    resolve(root, "apps/browser-extension/public/logo-16.png"),
    resolve(dIcons, "32x32.png"),
    resolve(dir, "tmp-48.png"),
    resolve(dIcons, "64x64.png"),
    resolve(dIcons, "128x128.png"),
    resolve(dIcons, "128x128@2x.png"),
  ],
  resolve(dIcons, "icon.ico"),
);
