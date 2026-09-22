import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outfile = join(root, "dist/content.js");

await build({
  entryPoints: [join(root, "src/content/bilibili.ts")],
  bundle: true,
  format: "iife",
  outfile,
  target: ["chrome114"],
  legalComments: "none",
});

const manifestPath = join(root, "dist/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const cs of manifest.content_scripts ?? []) {
  cs.js = ["content.js"];
  delete cs.all_frames;
}
if (Array.isArray(manifest.web_accessible_resources)) {
  for (const block of manifest.web_accessible_resources) {
    if (!Array.isArray(block.resources)) continue;
    block.resources = block.resources.filter((r) => !String(r).includes("bilibili.ts"));
  }
  manifest.web_accessible_resources = manifest.web_accessible_resources.filter(
    (block) => Array.isArray(block.resources) && block.resources.length,
  );
}

const scripts = (manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []);
if (scripts.length !== 1 || scripts[0] !== "content.js") {
  throw new Error(`content_scripts must be exactly [content.js], got ${JSON.stringify(scripts)}`);
}
if (scripts.some((s) => String(s).includes("loader") || String(s).includes("bilibili.ts"))) {
  throw new Error("CRXJS module loader must not ship in content_scripts");
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log("bundled content.js (IIFE, CSP-safe)");
