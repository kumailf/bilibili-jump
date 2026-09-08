import {
  type FrameFeatures,
  averageFeatures,
  contentDiff,
  featureSimilarity,
} from "./fingerprint";
import { clamp, linspace, mean, softScore } from "./math";
import type { FrameSampler } from "./video-sampler";

export type { FrameSampler } from "./video-sampler";

export interface DetectOptions {
  minFillerSeconds: number;
  seekToleranceSeconds: number;
  /** 软阈值：单点 delta；最终仍靠多信号置信度 */
  deltaThreshold?: number;
  /** 自动采纳最低置信度（高置信优先） */
  minConfidence?: number;
  bodyRange?: [number, number];
  tailAnchorSeconds?: number;
  onProgress?: (msg: string) => void;
}

export interface SignalScores {
  /** 片尾相对正文的域偏移 */
  domainShift: number;
  /** 片尾内部自洽 */
  tailCoherence: number;
  /** 正文/片尾可分性 */
  bodyTailSep: number;
  /** 边界附近硬切强度 */
  cutStrength: number;
  /** 起点之后持续像填充的比例 */
  sustained: number;
}

export interface DetectResult {
  found: boolean;
  fillerStart: number | null;
  duration: number;
  reason: string;
  /** 0–1，越高越可信；&lt; minConfidence 时 found 仍可为 false */
  confidence: number;
  signals?: SignalScores;
  debug?: {
    bodyMeanDelta: number;
    tailMeanDelta: number;
    probes: number;
    coarseStart: number | null;
  };
}

const DEFAULT_DELTA = 0.035;
const DEFAULT_MIN_CONF = 0.72;
const DEFAULT_BODY: [number, number] = [0.08, 0.4];
const DEFAULT_TAIL_SEC = 100;

function deltaOf(fp: FrameFeatures, body: FrameFeatures, tail: FrameFeatures): number {
  return featureSimilarity(fp, tail) - featureSimilarity(fp, body);
}

async function sampleMany(sample: FrameSampler, times: number[]): Promise<{ t: number; fp: FrameFeatures }[]> {
  const out: { t: number; fp: FrameFeatures }[] = [];
  for (const t of times) {
    const fp = await sample(Math.max(0, t));
    if (fp) out.push({ t, fp });
  }
  return out;
}

function pairwiseMeanSim(parts: FrameFeatures[]): number {
  if (parts.length < 2) return 0;
  let s = 0;
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      s += featureSimilarity(parts[i]!, parts[j]!);
      n += 1;
    }
  }
  return n ? s / n : 0;
}

/**
 * 多信号片尾填充检测（高置信优先）。
 *
 * 参考：
 * - intro-skipper：多分析器交叉验证 + 连续区间确认，宁可不跳也不误跳
 * - PySceneDetect ContentDetector：HSV/亮度内容差作切点证据
 *
 * 流程：粗扫时间线 → 门控 → 二分精修 → 边界硬切 + 持续性复核 → 置信度融合
 */
export async function detectFillerStart(
  duration: number,
  sample: FrameSampler,
  opts: DetectOptions,
): Promise<DetectResult> {
  const deltaThr = opts.deltaThreshold ?? DEFAULT_DELTA;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONF;
  const bodyRange = opts.bodyRange ?? DEFAULT_BODY;
  const tailSec = opts.tailAnchorSeconds ?? DEFAULT_TAIL_SEC;
  const minFiller = opts.minFillerSeconds;
  const tol = Math.max(0.8, opts.seekToleranceSeconds);
  const progress = opts.onProgress ?? (() => undefined);

  let probes = 0;
  const tracked: FrameSampler = async (t) => {
    probes += 1;
    return sample(t);
  };

  const empty = (reason: string, confidence = 0): DetectResult => ({
    found: false,
    fillerStart: null,
    duration,
    reason,
    confidence,
    debug: { bodyMeanDelta: 0, tailMeanDelta: 0, probes, coarseStart: null },
  });

  if (duration < minFiller + tailSec + 90) {
    return empty("视频过短，跳过分析");
  }

  // —— 1) 粗粒度时间线（后 70% 为主，兼顾正文基线）——
  progress("粗扫时间线…");
  const coarseStep = clamp(duration / 120, 12, 25);
  const coarseTimes = [
    ...linspace(duration * bodyRange[0], duration * bodyRange[1], 8),
    ...linspace(duration * 0.45, duration - 1.5, Math.max(16, Math.floor((duration * 0.55) / coarseStep))),
  ];
  // 去重并排序
  const uniqTimes = [...new Set(coarseTimes.map((t) => Math.round(t * 2) / 2))].sort((a, b) => a - b);
  const coarse = await sampleMany(tracked, uniqTimes);
  if (coarse.length < 12) return empty("抽帧不足，放弃");

  const bodyPts = coarse.filter((x) => x.t >= duration * bodyRange[0] && x.t <= duration * bodyRange[1]);
  const tailPts = coarse.filter((x) => x.t >= duration - tailSec);
  if (bodyPts.length < 4 || tailPts.length < 3) return empty("正文/片尾采样不足");

  const bodyMean = averageFeatures(bodyPts.map((x) => x.fp));
  const tailMean = averageFeatures(tailPts.map((x) => x.fp));
  if (!bodyMean || !tailMean) return empty("原型构建失败");

  const bodyDeltas = bodyPts.map((x) => deltaOf(x.fp, bodyMean, tailMean));
  const tailDeltas = tailPts.map((x) => deltaOf(x.fp, bodyMean, tailMean));
  const bodyMeanDelta = mean(bodyDeltas);
  const tailMeanDelta = mean(tailDeltas);

  const domainShiftRaw = tailMeanDelta - bodyMeanDelta;
  const tailCoherence = pairwiseMeanSim(tailPts.map((x) => x.fp));
  const bodyCoherence = pairwiseMeanSim(bodyPts.map((x) => x.fp));
  const bodyTailSep = contentDiff(bodyMean, tailMean);

  // 硬门控：片尾必须「更像自己」且与正文可分（高置信第一）
  if (tailMeanDelta < deltaThr || domainShiftRaw < deltaThr * 1.2) {
    return {
      ...empty(`域偏移不足 (Δtail=${tailMeanDelta.toFixed(3)}, shift=${domainShiftRaw.toFixed(3)})`),
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart: null },
    };
  }
  if (bodyTailSep < 0.08) {
    return {
      ...empty(`正文与片尾过于相似 (sep=${bodyTailSep.toFixed(3)})`),
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart: null },
    };
  }
  // 片尾应自洽；若比正文还散乱，更像随机噪声而非整段填充
  if (tailCoherence < 0.55 && tailCoherence + 0.05 < bodyCoherence) {
    return {
      ...empty(`片尾自洽性不足 (coh=${tailCoherence.toFixed(3)})`),
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart: null },
    };
  }

  // —— 2) 粗定位：找最早「连续像填充」的点 ——
  progress("粗定位填充段…");
  const series = coarse
    .filter((x) => x.t >= duration * 0.35)
    .map((x) => ({ t: x.t, d: deltaOf(x.fp, bodyMean, tailMean), fp: x.fp }));

  const needRun = Math.max(3, Math.ceil(45 / coarseStep)); // 约连续 ≥45s
  let coarseStart: number | null = null;
  for (let i = 0; i <= series.length - needRun; i++) {
    const win = series.slice(i, i + needRun);
    if (win.every((p) => p.d >= deltaThr) && mean(win.map((p) => p.d)) >= deltaThr + 0.01) {
      coarseStart = win[0]!.t;
      break;
    }
  }
  if (coarseStart == null) {
    return {
      ...empty("未找到持续填充段"),
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart: null },
    };
  }

  // —— 3) 二分精修（仅在粗点邻域，减少误伤）——
  progress("精修边界…");
  let lo = Math.max(duration * 0.3, coarseStart - coarseStep * 2);
  let hi = Math.min(duration - minFiller, coarseStart + coarseStep);

  const meanDeltaAt = async (t: number): Promise<number | null> => {
    const pts = await sampleMany(tracked, [t, t + 1.2, t + 2.5]);
    if (!pts.length) return null;
    return mean(pts.map((p) => deltaOf(p.fp, bodyMean, tailMean)));
  };

  const isFiller = async (t: number) => {
    const d = await meanDeltaAt(t);
    return d != null && d >= deltaThr;
  };

  // 确保 hi 为填充、lo 尽量为正文
  if (!(await isFiller(hi))) hi = Math.min(duration - 5, coarseStart + coarseStep * 2);
  if (await isFiller(lo)) lo = Math.max(duration * 0.25, lo - coarseStep * 2);

  while (hi - lo > tol) {
    const m = (lo + hi) / 2;
    if (await isFiller(m)) hi = m;
    else lo = m;
  }
  let fillerStart = hi;

  // —— 4) 边界硬切强度（ContentDetector 风格）——
  progress("复核边界与持续性…");
  const around = await sampleMany(tracked, [
    fillerStart - 3,
    fillerStart - 1.2,
    fillerStart + 0.4,
    fillerStart + 2.5,
    fillerStart + 5,
  ]);
  let cutStrength = 0;
  for (let i = 0; i < around.length - 1; i++) {
    if (around[i]!.t < fillerStart && around[i + 1]!.t >= fillerStart) {
      cutStrength = Math.max(cutStrength, contentDiff(around[i]!.fp, around[i + 1]!.fp));
    }
    cutStrength = Math.max(cutStrength, contentDiff(around[i]!.fp, around[i + 1]!.fp) * 0.85);
  }

  // 持续性：从起点到片尾再抽若干点
  const sustainTimes = linspace(fillerStart + 5, duration - 2, 6);
  const sustainPts = await sampleMany(tracked, sustainTimes);
  const sustainHits = sustainPts.filter((p) => deltaOf(p.fp, bodyMean, tailMean) >= deltaThr).length;
  const sustained = sustainPts.length ? sustainHits / sustainPts.length : 0;

  if (sustained < 0.66) {
    return {
      found: false,
      fillerStart: null,
      duration,
      reason: `填充持续性不足 (${(sustained * 100).toFixed(0)}%)`,
      confidence: sustained * 0.5,
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart },
    };
  }

  const fillerLen = duration - fillerStart;
  if (fillerLen < minFiller) {
    return {
      found: false,
      fillerStart: null,
      duration,
      reason: `填充过短 (${fillerLen.toFixed(1)}s)`,
      confidence: 0.2,
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart },
    };
  }

  // —— 5) 置信度融合（intro-skipper 式多信号）——
  const signals: SignalScores = {
    domainShift: softScore(domainShiftRaw, 0.06, 40),
    tailCoherence: softScore(tailCoherence, 0.7, 12),
    bodyTailSep: softScore(bodyTailSep, 0.12, 25),
    cutStrength: softScore(cutStrength, 0.18, 18),
    sustained: clamp(sustained, 0, 1),
  };

  // 权重：域偏移与持续性最高；硬切加分但不单独决定（有的填充是溶解转场）
  const confidence =
    0.28 * signals.domainShift +
    0.14 * signals.tailCoherence +
    0.18 * signals.bodyTailSep +
    0.12 * signals.cutStrength +
    0.28 * signals.sustained;

  if (confidence < minConf) {
    return {
      found: false,
      fillerStart,
      duration,
      reason: `置信度不足 ${(confidence * 100).toFixed(0)}% < ${(minConf * 100).toFixed(0)}%（疑似起点 ${formatClock(fillerStart)}）`,
      confidence,
      signals,
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart },
    };
  }

  return {
    found: true,
    fillerStart,
    duration,
    reason: `高置信填充 ${formatClock(fillerLen)}（自 ${formatClock(fillerStart)}，置信 ${(confidence * 100).toFixed(0)}%）`,
    confidence,
    signals,
    debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart },
  };
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}
