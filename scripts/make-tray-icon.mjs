// Generates the tray icons consumed by src-tauri/src/main.rs.
//
//   icons/tray-template.rgba  — macOS template image, 32x32 RGBA (black + alpha)
//   icons/tray-color.rgba     — fallback for non-macOS, 32x32 RGBA
//   icons/tray-template-{16,32,64}.png  — for inspection / debugging
//   icons/tray-color-32.png             — for inspection / debugging
//
// Run with: node scripts/make-tray-icon.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDir = join(root, "src-tauri", "icons");

// 32x32 viewBox. Designed bold + crisp so it reads at the macOS menu-bar
// rendering size (~22px tall on retina). The motif mirrors the app icon:
// a rounded search bar with a magnifying glass and a sparkle popping out
// of the upper right — but rendered as solid silhouette geometry, no
// sketchy/textured strokes.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g fill="black" stroke="none">
    <!-- search bar: rounded rect drawn as filled path so the inside punches out -->
    <path fill-rule="evenodd" d="
      M 6 13
      a 4 4 0 0 0 -4 4
      v 5
      a 4 4 0 0 0 4 4
      h 16
      a 4 4 0 0 0 4 -4
      v -5
      a 4 4 0 0 0 -4 -4
      Z
      M 6 15
      h 16
      a 2 2 0 0 1 2 2
      v 5
      a 2 2 0 0 1 -2 2
      h -16
      a 2 2 0 0 1 -2 -2
      v -5
      a 2 2 0 0 1 2 -2
      Z
    "/>
    <!-- magnifying glass body (ring) -->
    <path fill-rule="evenodd" d="
      M 9 19.5
      a 2.6 2.6 0 1 0 5.2 0
      a 2.6 2.6 0 1 0 -5.2 0
      Z
      M 10.4 19.5
      a 1.2 1.2 0 1 1 2.4 0
      a 1.2 1.2 0 1 1 -2.4 0
      Z
    "/>
    <!-- magnifying glass handle -->
    <rect x="13.4" y="20.9" width="2.2" height="1.2" rx="0.6" transform="rotate(45 13.4 20.9)"/>
    <!-- input line inside the bar -->
    <rect x="16" y="19" width="6" height="1.6" rx="0.8"/>
    <!-- sparkle (4-point star) popping out top-right -->
    <path d="
      M 25 2
      L 26.3 7.7
      L 32 9
      L 26.3 10.3
      L 25 16
      L 23.7 10.3
      L 18 9
      L 23.7 7.7
      Z
    "/>
  </g>
</svg>`;

const tmp = mkdtempSync(join(tmpdir(), "ken-tray-"));
try {
  const svgPath = join(tmp, "tray.svg");
  writeFileSync(svgPath, svg);

  const renderPng = (outPath, size) => {
    execFileSync(
      "rsvg-convert",
      ["-w", String(size), "-h", String(size), "-o", outPath, svgPath],
      { stdio: "inherit" }
    );
  };

  // Render the inspection PNGs alongside the .rgba buffers.
  const tplPaths = {
    16: join(iconsDir, "tray-template-16.png"),
    32: join(iconsDir, "tray-template-32.png"),
    64: join(iconsDir, "tray-template-64.png"),
  };
  for (const [size, p] of Object.entries(tplPaths)) renderPng(p, Number(size));

  // PIL converts the PNG to a raw RGBA buffer. We do this for 32x32 since
  // Tauri's TrayIconBuilder is configured for that size.
  const writeRgba = (pngPath, rgbaPath, { tint = "black" } = {}) => {
    execFileSync(
      "python3",
      [
        "-c",
        `import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert('RGBA')
if sys.argv[3] == 'black':
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            px[x, y] = (0, 0, 0, a)
with open(sys.argv[2], 'wb') as f:
    f.write(img.tobytes())
`,
        pngPath,
        rgbaPath,
        tint,
      ],
      { stdio: "inherit" }
    );
  };

  writeRgba(tplPaths[32], join(iconsDir, "tray-template.rgba"), { tint: "black" });

  // Color fallback (non-macOS): same shape, also rendered black so it
  // matches the look across platforms — Tauri only treats it as a template
  // image on macOS.
  const colorPng = join(iconsDir, "tray-color-32.png");
  renderPng(colorPng, 32);
  writeRgba(colorPng, join(iconsDir, "tray-color.rgba"), { tint: "black" });

  console.log("Wrote tray icons to", iconsDir);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
