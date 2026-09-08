# 样例分析：BV1HpAMznEss p39（意难忘 089）

- URL: https://www.bilibili.com/video/BV1HpAMznEss?p=39
- cid: `36913745525`
- 时长: **3435s**（≈57:15）

## 结论

| 项 | 值 |
|----|-----|
| 正片 | 约 0–40:40，棚内剧情（台标「民視第一台 HD」、字幕对白） |
| 填充起点 | **≈ 2440s（40:40）** |
| 填充内容 | 山景 / 日落等风光空镜（与剧情视觉分布明显不同） |
| 填充时长 | ≈ 995s（约 16.5 分钟） |

判定特征（32×32 + HSV 直方图，多信号）：

- `delta = sim(frame, tail) − sim(frame, body)`（sim 含亮度网格 + HSV 直方图）
- 硬门控：域偏移 / 正文片尾可分 / 片尾自洽
- 连续段粗定位 → 二分精修 → 边界硬切 + 持续性
- 默认 `minConfidence = 0.72`，不足则不自动跳

离线脚本与扩展 `detect.ts` 对齐。

## 复现

```bash
# 需本机 ffmpeg + yt-dlp
python -m yt_dlp -f "30011+30216" -o .scratch/p39.mp4 \
  "https://www.bilibili.com/video/BV1HpAMznEss?p=39"
python scripts/offline_analyze.py .scratch/p39.mp4
```

`.scratch/` 已 gitignore，勿提交成片。
