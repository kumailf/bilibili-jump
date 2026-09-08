# bilibili-jump · 比利空降助手

自动识别 B 站片尾**版权规避填充**并跳过。交互对齐「小电视空降助手」：开关控制、进度条着色、其余静默。

## 用户怎么用

1. 安装扩展  
2. 点击图标，确认 **启用**（默认开启）  
3. 打开长视频，先正常看；等前面缓冲够、已播放约十几秒后，扩展在后台用预览雪碧图分析（不打断当前播放）。成功才在进度条标色。  

低置信或不适用的视频：**无提示、不打扰**。

## 开发 / 打包

```bash
npm install
npm run build          # 输出 dist/
npm run pack           # dist + release/bilibili-jump-chrome.zip
```

Chrome → `chrome://extensions` → 开发者模式 → **加载已解压的扩展程序** → 选 `dist/`（或 `release/bilibili-jump`）。

上架材料见 [`docs/chrome-web-store.md`](docs/chrome-web-store.md)。

## 隐私

- 分析仅在本机 Chrome 进行，**不上传视频、不收集账号**  
- `chrome.storage` 仅保存：总开关 + 已确认跳过段的起点/终点  

## 技术摘要

多信号视觉检测（优先用 B 站进度条雪碧图，不 seek 正在播放的画面）。高置信才落盘并标进度条。详见 `docs/sample-BV1HpAMznEss-p39.md`。
