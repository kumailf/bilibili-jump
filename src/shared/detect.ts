/**
 * 研究/离线用检测（非生产路径）。
 * 商店包与 content 只走 `detect-joint.ts`。
 */
import {
  type FrameFeatures,
  averageFeatures,
  contentDiff,
  featureSimilarity,
} from "./fingerprint";
import { clamp, linspace, mean, median, softScore } from "./math";
import type { FrameSampler } from "./video-sampler";

export type { FrameSampler } from "./video-sampler";

export interface DetectOptions {
  minFillerSeconds: number;
  seekToleranceSeconds: number;
  deltaThreshold?: number;
  minConfidence?: number;
  bodyRange?: [number, number];
  tailAnchorSeconds?: number;
  /** 雪碧图实际覆盖到的最晚时间（勿用 duration 去抽不存在的尾帧） */
  coverageEnd?: number;
  /** videoshot index 时间戳，用于「抽帧变稀」辅助定位 */
  keyframeTimes?: number[];
  onProgress?: (msg: string) => void;
}

export interface SignalScores {
  domainShift: number;
  tailCoherence: number;
  bodyTailSep: number;
  cutStrength: number;
  sustained: number;
}

export interface DetectResult {
  found: boolean;
  fillerStart: number | null;
  duration: number;
  reason: string;
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
const PREVIEW_LOOKAHEAD_SEC = 18;
const WINDOW_SEC = 48;

type SamplePt = { t: number; fp: FrameFeatures; d: number };

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

function toPts(
  raw: { t: number; fp: FrameFeatures }[],
  body: FrameFeatures,
  tail: FrameFeatures,
): SamplePt[] {
  const pts = raw
    .map((x) => ({ t: x.t, fp: x.fp, d: deltaOf(x.fp, body, tail) }))
    .sort((a, b) => a.t - b.t);
  const uniq: SamplePt[] = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (last && Math.abs(last.t - p.t) < 0.05) continue;
    uniq.push(p);
  }
  return uniq;
}

/** 丢掉与多数尾帧差太远的离群点（避免末格标题卡污染原型） */
function robustAverageFeatures(parts: FrameFeatures[]): FrameFeatures | null {
  if (parts.length < 3) return averageFeatures(parts);
  const scores = parts.map((p, i) => {
    let s = 0;
    let n = 0;
    for (let j = 0; j < parts.length; j++) {
      if (i === j) continue;
      s += featureSimilarity(p, parts[j]!);
      n += 1;
    }
    return n ? s / n : 0;
  });
  const med = median(scores);
  const kept = parts.filter((_, i) => scores[i]! >= med - 0.08);
  return averageFeatures(kept.length >= 2 ? kept : parts);
}

/** [t0, t0+win] 内 delta 均值；点太少则无效。 */
function windowMeanDelta(series: SamplePt[], t0: number, winSec: number): number | null {
  const vals: number[] = [];
  for (const p of series) {
    if (p.t < t0) continue;
    if (p.t > t0 + winSec) break;
    vals.push(p.d);
  }
  if (vals.length < 2) return null;
  return mean(vals);
}

/**
 * 找最早的 t*：局部窗口像片尾，且从 t* 到覆盖末端的填充占比足够高。
 * 上界用 coverageEnd，避免雪碧图未覆盖的片尾把 endMean 抽空。
 */
function locateFillerStart(
  series: SamplePt[],
  duration: number,
  coverageEnd: number,
  minFiller: number,
  deltaThr: number,
  seekTol: number,
  winSec = WINDOW_SEC,
  minSuffixFrac = 0.72,
): number | null {
  if (series.length < 4) return null;
  const spanEnd = Math.min(duration, coverageEnd);
  const lo = duration * 0.28;
  const hiLimit = spanEnd - minFiller;
  if (hiLimit - lo < seekTol) return null;

  const endMean = windowMeanDelta(series, Math.max(lo, spanEnd - winSec), winSec);
  if (endMean == null || endMean < deltaThr) return null;

  let leftBound = lo;
  let hit: number | null = null;
  for (const p of series) {
    if (p.t < lo) continue;
    if (p.t > hiLimit) break;
    const wm = windowMeanDelta(series, p.t, winSec);
    if (wm == null || wm < deltaThr) {
      leftBound = p.t;
      continue;
    }
    const suffix = series.filter((q) => q.t >= p.t);
    if (suffix.length < 3) continue;
    const frac = suffix.filter((q) => q.d >= deltaThr).length / suffix.length;
    if (frac < minSuffixFrac) continue;
    hit = p.t;
    break;
  }
  if (hit == null) return null;

  // 在「上一处仍偏正文」与 hit 之间二分收紧
  let loB = leftBound;
  let hiB = hit;
  while (hiB - loB > seekTol) {
    const mid = (loB + hiB) / 2;
    const wm = windowMeanDelta(series, mid, winSec);
    const suffix = series.filter((q) => q.t >= mid);
    const frac = suffix.length ? suffix.filter((q) => q.d >= deltaThr).length / suffix.length : 0;
    if (wm != null && wm >= deltaThr && frac >= minSuffixFrac) hiB = mid;
    else loB = mid;
  }
  if (spanEnd - hiB < minFiller) return null;
  return hiB;
}

type BodySimPt = { t: number; s: number };

/** 相对正文相似度的变点：左侧更像正文、右侧整体掉下去。 */
function bodySimChangePoint(
  sims: BodySimPt[],
  bodyMeanSim: number,
  duration: number,
  coverageEnd: number,
  minFiller: number,
): { t: number; score: number } | null {
  if (sims.length < 12) return null;
  const pref: number[] = [0];
  for (const p of sims) pref.push(pref[pref.length - 1]! + p.s);
  const n = sims.length;
  let bestT: number | null = null;
  let bestScore = -1;
  for (let i = 1; i < n - 1; i++) {
    const t = sims[i]!.t;
    if (t < duration * 0.3) continue;
    if (coverageEnd - t < Math.max(minFiller, 90)) continue;
    const left = pref[i]! / i;
    const right = (pref[n]! - pref[i]!) / (n - i);
    const drop = left - right;
    if (right > bodyMeanSim - 0.04) continue;
    if (drop < 0.04) continue;
    const score = drop + Math.max(0, bodyMeanSim - right) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestT = t;
    }
  }
  if (bestT == null || bestScore < 0.12) return null;
  return { t: bestT, score: bestScore };
}

/**
 * 融合：雪碧图变稀 / 片尾窗口定位 / 正文相似度变点。
 * 变点用于纠正「只咬到最后一两分钟」或「视觉起点偏晚」的情况。
 */
function fuseCandidateStarts(
  visual: number | null,
  sparse: number | null,
  change: { t: number; score: number } | null,
  duration: number,
  coverageEnd: number,
): { start: number | null; usedSparse: boolean; usedChange: boolean } {
  if (sparse != null && (visual == null || visual - sparse > 90)) {
    return { start: sparse, usedSparse: true, usedChange: false };
  }
  if (change && change.score >= 0.12) {
    const chg = change.t;
    const chgLen = duration - chg;
    const visLen = visual != null ? duration - visual : 0;
    const farFromEnd = coverageEnd - chg > 300;
    if (farFromEnd && chgLen > 600) {
      if (visual == null || (visLen < 300 && change.score >= 0.12)) {
        return { start: chg, usedSparse: false, usedChange: true };
      }
      if (visual != null && visual > chg + 180 && change.score >= 0.15) {
        return { start: chg, usedSparse: false, usedChange: true };
      }
    }
    if (visual != null && Math.abs(chg - visual) < 180) {
      return { start: chg, usedSparse: false, usedChange: true };
    }
  }
  if (visual != null) return { start: visual, usedSparse: false, usedChange: false };
  if (change && change.score >= 0.15) {
    return { start: change.t, usedSparse: false, usedChange: true };
  }
  if (sparse != null) return { start: sparse, usedSparse: true, usedChange: false };
  return { start: null, usedSparse: false, usedChange: false };
}

/** 段首若是下集预告（数秒后才切到真正无意义片段），收到硬切之后。 */
async function skipShortPreview(
  sample: FrameSampler,
  start: number,
  duration: number,
  minFiller: number,
  body: FrameFeatures,
  tail: FrameFeatures,
  deltaThr: number,
): Promise<number> {
  const end = Math.min(duration - minFiller, start + PREVIEW_LOOKAHEAD_SEC);
  if (end - start < 3) return start;
  const times = linspace(Math.max(0, start - 0.8), end, Math.max(8, Math.ceil((end - start) / 1.2)));
  const pts = await sampleMany(sample, times);
  if (pts.length < 3) return start;

  const d0 = deltaOf(pts[0]!.fp, body, tail);
  let best = start;
  let bestScore = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (b.t - start < 2.8) continue;
    const cut = contentDiff(a.fp, b.fp);
    const d1 = deltaOf(b.fp, body, tail);
    if (d1 < deltaThr) continue;
    const score = cut + Math.max(0, d1 - d0);
    if (cut >= 0.16 && score > bestScore) {
      bestScore = score;
      best = b.t;
    }
  }
  return best;
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
 * 预览雪碧图在静态/循环片尾常把抽帧间隔拉大。
 * 找「间隔相对前半明显变稀、且一直稀到索引末尾」的最早时刻。
 */
export function sparseKeyframeStart(
  index: number[],
  duration: number,
  minFillerSeconds: number,
): number | null {
  if (!Array.isArray(index) || index.length < 40) return null;
  const dts: { t: number; dt: number }[] = [];
  for (let i = 0; i < index.length - 1; i++) {
    const a = Number(index[i]);
    const b = Number(index[i + 1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    dts.push({ t: a, dt: b - a });
  }
  if (dts.length < 30) return null;

  const early = median(dts.slice(0, Math.max(20, dts.length >> 2)).map((x) => x.dt));
  if (early < 1) return null;

  const win = 12;
  for (let i = 0; i < dts.length - win; i++) {
    const t = dts[i]!.t;
    if (t < duration * 0.28) continue;
    if (duration - t < minFillerSeconds) break;
    const window = dts.slice(i, i + win);
    const high = window.filter((x) => x.dt >= early * 1.35).length;
    if (high < win * 0.66) continue;
    if (dts[i]!.dt < early * 1.35) continue;
    const restMed = median(dts.slice(i).map((x) => x.dt));
    if (restMed < early * 1.25) continue;
    return t;
  }
  return null;
}

/** 从候选起点起，关键帧间隔持续偏稀的比例 */
function sparseSustainFrac(index: number[], start: number, earlyDt: number): number {
  const dts: number[] = [];
  for (let i = 0; i < index.length - 1; i++) {
    const a = Number(index[i]);
    const b = Number(index[i + 1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || a < start) continue;
    dts.push(b - a);
  }
  if (dts.length < 4) return 0;
  return dts.filter((d) => d >= earlyDt * 1.2).length / dts.length;
}

function earlyKeyframeDt(index: number[]): number {
  const dts: number[] = [];
  for (let i = 0; i < index.length - 1; i++) {
    const a = Number(index[i]);
    const b = Number(index[i + 1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    dts.push(b - a);
    if (dts.length >= Math.max(20, (index.length - 1) >> 2)) break;
  }
  return median(dts);
}

/**
 * 片尾无意义片段检测（高置信优先）。
 *
 * 定位：窗口均值二分 +（可选）雪碧图抽帧变稀 → 边界加密 → 段首跳过短预告。
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
  const seekTol = Math.max(1.2, opts.seekToleranceSeconds || 2);
  const coverageEnd = Math.min(duration, Math.max(duration * 0.5, opts.coverageEnd ?? duration));
  const keyframes = opts.keyframeTimes ?? [];
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

  progress("采样时间线…");
  const lateStep = clamp(duration / 160, 8, 16);
  const sampleEnd = Math.max(duration * 0.4, coverageEnd - 1.2);
  const uniqTimes = [
    ...linspace(duration * bodyRange[0], duration * bodyRange[1], 8),
    ...linspace(duration * 0.35, sampleEnd, Math.max(18, Math.floor((duration * 0.65) / lateStep))),
  ]
    .map((t) => Math.round(t * 2) / 2)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .sort((a, b) => a - b);

  const coarse = await sampleMany(tracked, uniqTimes);
  if (coarse.length < 12) return empty("抽帧不足，放弃");

  const bodyPts = coarse.filter((x) => x.t >= duration * bodyRange[0] && x.t <= duration * bodyRange[1]);
  let tailPts = coarse.filter((x) => x.t >= coverageEnd - tailSec && x.t <= coverageEnd + 0.5);
  if (tailPts.length < 3) {
    tailPts = [...coarse].sort((a, b) => b.t - a.t).slice(0, 8);
  }
  if (bodyPts.length < 4 || tailPts.length < 3) return empty("正文/片尾采样不足");

  const bodyMean = averageFeatures(bodyPts.map((x) => x.fp));
  const tailMean = robustAverageFeatures(tailPts.map((x) => x.fp));
  if (!bodyMean || !tailMean) return empty("原型构建失败");

  const bodyMeanDelta = mean(bodyPts.map((x) => deltaOf(x.fp, bodyMean, tailMean)));
  const tailMeanDelta = mean(tailPts.map((x) => deltaOf(x.fp, bodyMean, tailMean)));
  const domainShiftRaw = tailMeanDelta - bodyMeanDelta;
  const tailCoherence = pairwiseMeanSim(tailPts.map((x) => x.fp));
  const bodyCoherence = pairwiseMeanSim(bodyPts.map((x) => x.fp));
  const bodyTailSep = contentDiff(bodyMean, tailMean);

  const sparseStart = sparseKeyframeStart(keyframes, duration, minFiller);
  const hasSparseCue = sparseStart != null;
  const bodyMeanSim = mean(bodyPts.map((x) => featureSimilarity(x.fp, bodyMean)));
  const lateSims: BodySimPt[] = coarse
    .filter((x) => x.t >= duration * 0.25)
    .map((x) => ({ t: x.t, s: featureSimilarity(x.fp, bodyMean) }));
  const changeHit = bodySimChangePoint(lateSims, bodyMeanSim, duration, coverageEnd, minFiller);
  const hasChangeCue = changeHit != null && changeHit.score >= 0.15;

  if (!hasSparseCue && !hasChangeCue) {
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
    if (tailCoherence < 0.55 && tailCoherence + 0.05 < bodyCoherence) {
      return {
        ...empty(`片尾自洽性不足 (coh=${tailCoherence.toFixed(3)})`),
        debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart: null },
      };
    }
  }

  progress("定位片尾无意义片段…");
  let pts = toPts(coarse, bodyMean, tailMean);
  const visualStart = locateFillerStart(pts, duration, coverageEnd, minFiller, deltaThr, seekTol);
  let { start: fillerStart, usedSparse, usedChange } = fuseCandidateStarts(
    visualStart,
    sparseStart,
    changeHit,
    duration,
    coverageEnd,
  );

  if (fillerStart == null) {
    return {
      ...empty("未找到接到片尾的无意义片段"),
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart: null },
    };
  }
  const coarseStart = fillerStart;

  progress("加密边界…");
  const denser = await sampleMany(
    tracked,
    linspace(Math.max(duration * 0.28, fillerStart - 40), Math.min(coverageEnd - 1, fillerStart + 24), 28),
  );
  pts = toPts([...coarse, ...denser], bodyMean, tailMean);
  if (!usedSparse && !usedChange) {
    const refined = locateFillerStart(
      pts.filter((p) => p.t >= duration * 0.28),
      duration,
      coverageEnd,
      minFiller,
      deltaThr,
      seekTol,
    );
    if (refined != null) fillerStart = refined;
  } else if (usedChange) {
    const denserSims: BodySimPt[] = denser.map((x) => ({
      t: x.t,
      s: featureSimilarity(x.fp, bodyMean),
    }));
    const mergedSims = [...lateSims, ...denserSims].sort((a, b) => a.t - b.t);
    const refinedChange = bodySimChangePoint(mergedSims, bodyMeanSim, duration, coverageEnd, minFiller);
    if (refinedChange && refinedChange.score >= 0.12) fillerStart = refinedChange.t;
  }

  fillerStart = await skipShortPreview(tracked, fillerStart, duration, minFiller, bodyMean, tailMean, deltaThr);

  progress("复核持续性…");
  const around = await sampleMany(tracked, [
    fillerStart - 4,
    fillerStart - 1,
    fillerStart + 0.5,
    fillerStart + 3,
    fillerStart + 6,
  ]);
  let cutStrength = 0;
  for (let i = 0; i < around.length - 1; i++) {
    const cut = contentDiff(around[i]!.fp, around[i + 1]!.fp);
    if (around[i]!.t < fillerStart && around[i + 1]!.t >= fillerStart) {
      cutStrength = Math.max(cutStrength, cut);
    } else {
      cutStrength = Math.max(cutStrength, cut * 0.85);
    }
  }

  const sustainEnd = Math.min(duration - 2, coverageEnd - 1);
  const sustainTimes = linspace(fillerStart + 5, Math.max(fillerStart + 6, sustainEnd), 6);
  const sustainPts = await sampleMany(tracked, sustainTimes);
  let sustained = sustainPts.length
    ? sustainPts.filter((p) => deltaOf(p.fp, bodyMean, tailMean) >= deltaThr).length / sustainPts.length
    : 0;

  if (usedSparse && keyframes.length) {
    const earlyDt = earlyKeyframeDt(keyframes);
    sustained = Math.max(sustained, sparseSustainFrac(keyframes, fillerStart, earlyDt));
  }
  if (usedChange) {
    const unlike = sustainPts.length
      ? sustainPts.filter((p) => featureSimilarity(p.fp, bodyMean) <= bodyMeanSim - 0.04).length /
        sustainPts.length
      : 0;
    sustained = Math.max(sustained, unlike);
  }

  if (sustained < 0.66) {
    return {
      found: false,
      fillerStart: null,
      duration,
      reason: `片段持续性不足 (${(sustained * 100).toFixed(0)}%)`,
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
      reason: `片段过短 (${fillerLen.toFixed(1)}s)`,
      confidence: 0.2,
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart },
    };
  }

  const signals: SignalScores = {
    domainShift: softScore(
      Math.max(domainShiftRaw, usedSparse || usedChange ? 0.08 : domainShiftRaw),
      0.06,
      40,
    ),
    tailCoherence: softScore(
      Math.max(tailCoherence, usedSparse || usedChange ? 0.7 : tailCoherence),
      0.7,
      12,
    ),
    bodyTailSep: softScore(
      Math.max(bodyTailSep, usedSparse || usedChange ? 0.12 : bodyTailSep),
      0.12,
      25,
    ),
    cutStrength: softScore(cutStrength, 0.18, 18),
    sustained: clamp(sustained, 0, 1),
  };
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
      reason: `置信度不足 ${(confidence * 100).toFixed(0)}%`,
      confidence,
      signals,
      debug: { bodyMeanDelta, tailMeanDelta, probes, coarseStart },
    };
  }

  return {
    found: true,
    fillerStart,
    duration,
    reason: `高置信片段 ${formatClock(fillerLen)}（自 ${formatClock(fillerStart)}，置信 ${(confidence * 100).toFixed(0)}%）`,
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
