# 样例分析：BV1HpAMznEss p39（意难忘 089）

- URL: https://www.bilibili.com/video/BV1HpAMznEss?p=39
- cid: `36913745525`
- 时长: **3435s**（≈57:15）

## 结论

| 项 | 值 |
|----|-----|
| 正片 | 约 0–40:40，棚内剧情（台标「民視第一台 HD」、字幕对白） |
| 无意义片段起点 | **≈ 2440s（40:40）** |
| 片段内容 | 山景 / 日落等风光空镜（与剧情视觉分布明显不同） |
| 片段时长 | ≈ 995s（约 16.5 分钟） |

判定特征（生产内核 `detect-joint`）：

- 画面：正文相似度跌落 / 静止上升 / 长 unlike 段
- 声音：播放头附近 ZCR/重心等（不 seek）
- 编码：雪碧图 index 变稀（辅助）
- **HIGH**（≥两路，有音频时必须含音频）→ 落盘并自动跳
- **MED**（一路较强）→ 只标条，不自动跳

生产路径与扩展 `detect-joint.ts` 对齐；`detect.ts` 为研究代码。

## 复现

```bash
# 需本机 ffmpeg + yt-dlp
python -m yt_dlp -f "30011+30216" -o .scratch/p39.mp4 \
  "https://www.bilibili.com/video/BV1HpAMznEss?p=39"
python scripts/offline_analyze.py .scratch/p39.mp4
```

`.scratch/` 已 gitignore，勿提交成片。
