import { cosineSimilarity } from "./math";

/** 下采样边长；32 在 seek 场景下仍很轻，比 16 更稳 */
export const SAMPLE_SIZE = 32;

const H_BINS = 16;
const S_BINS = 8;
const V_BINS = 8;

export interface FrameFeatures {
  /** SAMPLE_SIZE² 亮度 */
  luma: Float32Array;
  /** H+S+V 直方图，已归一化 */
  hsvHist: Float32Array;
  meanLuma: number;
  /** 简易边缘能量 0–1（高纹理/高对比更大） */
  edgeEnergy: number;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max < 1e-6 ? 0 : d / max;
  return [h, s, max];
}

/** 参考 PySceneDetect ContentDetector：HSV + 亮度网格 + 边缘 */
export function featuresFromRgba(data: Uint8ClampedArray, width: number, height: number): FrameFeatures {
  const luma = new Float32Array(SAMPLE_SIZE * SAMPLE_SIZE);
  const hsvHist = new Float32Array(H_BINS + S_BINS + V_BINS);
  let sumL = 0;
  let edgeAcc = 0;
  let edgeN = 0;

  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return [data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255] as const;
  };

  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let x = 0; x < SAMPLE_SIZE; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / SAMPLE_SIZE));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / SAMPLE_SIZE));
      const [r, g, b] = at(sx, sy);
      const yL = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[y * SAMPLE_SIZE + x] = yL;
      sumL += yL;

      const [h, s, v] = rgbToHsv(r, g, b);
      hsvHist[Math.min(H_BINS - 1, Math.floor(h * H_BINS))]! += 1;
      hsvHist[H_BINS + Math.min(S_BINS - 1, Math.floor(s * S_BINS))]! += 1;
      hsvHist[H_BINS + S_BINS + Math.min(V_BINS - 1, Math.floor(v * V_BINS))]! += 1;

      if (x > 0 && y > 0) {
        const left = luma[y * SAMPLE_SIZE + (x - 1)]!;
        const up = luma[(y - 1) * SAMPLE_SIZE + x]!;
        edgeAcc += Math.abs(yL - left) + Math.abs(yL - up);
        edgeN += 2;
      }
    }
  }

  const pix = SAMPLE_SIZE * SAMPLE_SIZE;
  for (let i = 0; i < H_BINS; i++) hsvHist[i]! /= pix;
  for (let i = 0; i < S_BINS; i++) hsvHist[H_BINS + i]! /= pix;
  for (let i = 0; i < V_BINS; i++) hsvHist[H_BINS + S_BINS + i]! /= pix;

  return {
    luma,
    hsvHist,
    meanLuma: sumL / pix,
    edgeEnergy: edgeN ? Math.min(1, edgeAcc / edgeN / 0.35) : 0,
  };
}

/** 直方图交集相似度 0–1 */
export function histIntersection(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.min(a[i]!, b[i]!);
  // HSV 三段各自归一后总和约 3，除以 3
  return Math.min(1, s / 3);
}

/**
 * 综合相似度（亮度网格 + HSV 分布 + 平均亮度）。
 * 比纯灰度余弦更接近 ContentDetector 的「内容差」语义。
 */
export function featureSimilarity(a: FrameFeatures, b: FrameFeatures): number {
  const lumaSim = cosineSimilarity(a.luma, b.luma);
  const histSim = histIntersection(a.hsvHist, b.hsvHist);
  const lumSim = 1 - Math.min(1, Math.abs(a.meanLuma - b.meanLuma) * 2.2);
  return 0.42 * lumaSim + 0.43 * histSim + 0.15 * lumSim;
}

export function averageFeatures(parts: FrameFeatures[]): FrameFeatures | null {
  if (!parts.length) return null;
  const luma = new Float32Array(parts[0]!.luma.length);
  const hsvHist = new Float32Array(parts[0]!.hsvHist.length);
  let meanLuma = 0;
  let edgeEnergy = 0;
  for (const p of parts) {
    for (let i = 0; i < luma.length; i++) luma[i]! += p.luma[i]!;
    for (let i = 0; i < hsvHist.length; i++) hsvHist[i]! += p.hsvHist[i]!;
    meanLuma += p.meanLuma;
    edgeEnergy += p.edgeEnergy;
  }
  const n = parts.length;
  for (let i = 0; i < luma.length; i++) luma[i]! /= n;
  for (let i = 0; i < hsvHist.length; i++) hsvHist[i]! /= n;
  return { luma, hsvHist, meanLuma: meanLuma / n, edgeEnergy: edgeEnergy / n };
}

/** 内容差 0–1，越高越像硬切（PySceneDetect 思路） */
export function contentDiff(a: FrameFeatures, b: FrameFeatures): number {
  return 1 - featureSimilarity(a, b);
}
