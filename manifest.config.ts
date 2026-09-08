import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "比利空降助手",
  short_name: "比利空降",
  description: "自动识别并跳过 B 站片尾版权规避填充片段，进度条标注可跳过区间。",
  version: pkg.version,
  icons: {
    "16": "public/icons/icon16.png",
    "32": "public/icons/icon32.png",
    "48": "public/icons/icon48.png",
    "128": "public/icons/icon128.png",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "比利空降助手",
    default_icon: {
      "16": "public/icons/icon16.png",
      "32": "public/icons/icon32.png",
      "48": "public/icons/icon48.png",
    },
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  permissions: ["storage"],
  host_permissions: [
    "*://www.bilibili.com/*",
    "*://api.bilibili.com/*",
    "*://*.hdslb.com/*",
  ],
  content_scripts: [
    {
      matches: [
        "*://www.bilibili.com/video/*",
        "*://www.bilibili.com/list/*",
        "*://www.bilibili.com/bangumi/play/*",
      ],
      js: ["src/content/bilibili.ts"],
      run_at: "document_idle",
    },
  ],
});
