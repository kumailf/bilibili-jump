# bilibili-jump · 比利空降助手

自动识别并跳过 B 站片尾**无意义片段**。交互对齐「小电视空降助手」：开关控制、进度条着色、其余静默。

## 用户怎么用

1. 安装扩展  
2. 点击图标，确认 **启用**（默认开启）  
3. 打开 **约 16 分钟以上** 的长视频正常看（短片算法窗口不够，不会标记）  

行为：

- **画面较强（MED）/ 画面交叉待音频确认**：进度条青色标段，播到该段可自动跳（不落盘）  
- **画面+声音交叉（HIGH）**：标段、写入缓存、自动跳  
- 纯音频误检：不画条  
- 不适用：静默  

## 开发 / 打包

```bash
npm install
npm run build
npm run pack
```

加载目录：`release/bilibili-jump`（或 `dist/`）。不要用 Vite 热更对 B 站调试。

上架材料见 [`docs/chrome-web-store.md`](docs/chrome-web-store.md)。

## 隐私

- 本机分析，不上传视频  
- `chrome.storage`：开关 + HIGH 已确认跳过段  

## 技术

生产内核：`src/shared/detect-joint.ts`。编排状态机：`src/content/bilibili.ts`。  
`src/shared/detect.ts` 为研究代码，不进 content。
