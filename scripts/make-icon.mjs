import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDir = join(root, "src-tauri", "icons");
const sourceIcon = join(iconsDir, "app-icon-source.png");
const input = process.argv[2] ? resolve(process.argv[2]) : sourceIcon;

if (!existsSync(input)) {
  throw new Error(`Icon source not found: ${input}`);
}

mkdirSync(iconsDir, { recursive: true });

if (input !== sourceIcon) {
  const width = Number(execFileSync("sips", ["-g", "pixelWidth", input], { encoding: "utf8" }).match(/pixelWidth:\s+(\d+)/)?.[1]);
  const height = Number(execFileSync("sips", ["-g", "pixelHeight", input], { encoding: "utf8" }).match(/pixelHeight:\s+(\d+)/)?.[1]);
  const size = Math.min(width, height);

  execFileSync("sips", ["--cropToHeightWidth", String(size), String(size), input, "--out", sourceIcon], {
    stdio: "inherit",
  });
}

execFileSync("sips", ["-z", "1024", "1024", sourceIcon], { stdio: "inherit" });
execFileSync("npx", ["tauri", "icon", sourceIcon], { cwd: root, stdio: "inherit" });
