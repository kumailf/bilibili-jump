import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "./zip-dir.mjs";

const root = process.cwd();
const dist = join(root, "dist");
const outDir = join(root, "release");
const stage = join(outDir, "bilibili-jump");

if (!existsSync(dist)) {
  console.error("dist/ missing, run build first");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(dist, stage, { recursive: true });

const zipPath = join(outDir, "bilibili-jump-chrome.zip");
zipSync(stage, zipPath);

writeFileSync(
  join(outDir, "README.txt"),
  [
    "比利空降助手 — Chrome 扩展发布包",
    "",
    "本地测试：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 bilibili-jump/",
    "商店上架：上传 bilibili-jump-chrome.zip",
    "",
  ].join("\n"),
  "utf8",
);

console.log("packed →", zipPath);
