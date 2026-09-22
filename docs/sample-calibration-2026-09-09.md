# 人工标定样例（2026-09-09）

## 第一批（较准）

| 链接 | 人工起点 | 说明 |
|------|----------|------|
| https://www.bilibili.com/video/BV1HpAMznEss?p=40 | **43:09** | 风光空镜 |
| https://www.bilibili.com/video/BV1mWBxBjEJz?p=6 | **46:50** | 需 videoshot `index` |
| https://www.bilibili.com/video/BV1iXBDBYEiH | **49:00** | |
| https://www.bilibili.com/video/BV1YexczuEyq | **47:45** | 抽帧变稀可辅助 |

## 第二批（你标的起点）

| 链接 | 人工起点 | 算法现状（画面） |
|------|----------|------------------|
| https://www.bilibili.com/video/BV1xHoUBQEwP/ | **49:03** | 正文相似度变点约 **50:18**（约 +1 分钟）；纯片尾窗口会偏到 80 分以后 |
| https://www.bilibili.com/video/BV1ceCCBwEJH/ | **42:03** | API **无 index**，雪碧图路径不用；播放中听声音（不 pause/seek） |
| https://www.bilibili.com/video/BV1wjkQBQEam/ | **44:59** | **仍难**：过渡平缓，易偏到约 31–32 分 |
| https://www.bilibili.com/video/BV1NR95BnEbw/ | **44:59** | 变点约 **44:45**（约 −15s）；纯片尾窗口会只咬最后约 2 分钟 |

## 策略摘要

1. 片尾窗口均值 + 后缀占比  
2. 雪碧图 `index` 变稀 → 可提前  
3. **正文相似度变点**：纠正「只检出最后一两分钟」或「视觉起点偏晚」  
4. **无可用 index 不线性估时**（避免 p6 那种约 70s 时钟偏差）

缓存键前缀 `v8|`。无可用 index 时不线性估时，改为播放中继续听声音。
