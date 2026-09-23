/**
 * 联合检测：画面 / 音频 / 抽帧变稀 独立打分。
 * HIGH = 至少两路（有音频采样时必须含音频）→ 落盘并自动跳。
 * MED = 一路较强：有画面时可标条并可跳（不落盘）；纯音频 MED 由 content 忽略。
 * 片长需 ≳ 2×SUSTAIN（约 16 分钟）才有扫描窗。
 */
import { averageFeatures, featureSimilarity, type FrameFeatures } from "./fingerprint";
import { mean, median } from "./math";
import type { AudioProbe } from "./audio-sampler";
import type { TimedFeature } from "./videoshot";

export type ConfLevel = "HIGH" | "MED" | "LOW" | "NONE";

export interface AudioFeat {
  n: number;
  points: AudioProbe[];
}

export interface JointDetectInput {
  duration: number;
  coverageEnd: number;
  series: TimedFeature[];
  keyframeTimes?: number[];
  audio?: AudioFeat | null;
}

export interface JointDetectResult {
  found: boolean;
  fillerStart: number | null;
  duration: number;
  reason: string;
  confidence: number;
  level: ConfLevel;
  probeCenters: number[];
}

type Tile = TimedFeature & { selfSim: number };

const PRE_SEC = 180;
const POST_SEC = 180;
const SUSTAIN_SEC = 480;
const STEP = 6;
const CLUSTER_GAP = 36;
const BODY_DROP_ON = 0.04;
const BODY_DROP_FULL = 0.12;
const STATIC_POST = 0.8;
const STATIC_RISE = 0.04;
const STATIC_RISE_FULL = 0.1;
const UNLIKE_SLACK = 0.045;
const UNLIKE_MIN_LEN = 240;
const UNLIKE_NEAR = 45;
/** 接片尾的 unlike 段：起点后短窗 selfSim 够高才视为真正静态垫片（风光空镜） */
const PAD_SELF_LOOK = 90;
const PAD_SELF_MIN = 0.93;
const PAD_SELF_RISE = 0.06;
/** 段末距 coverageEnd 小于此值视为「接到片尾」的 unlike */
const UNLIKE_TO_END_SLACK = 90;
const ZCR_PRE_MIN = 0.04;
const ZCR_POST_MAX = 0.032;
const ZCR_DROP_ON = 0.018;
const ZCR_DROP_FULL = 0.045;
const CEN_PRE_MIN = 1100;
const CEN_POST_MAX = 1150;
const CEN_DROP_ON = 200;
const CEN_DROP_FULL = 500;
const ZCR_SPEECH = 0.04;
const ZCR_SPEECH_BURST = 0.045;
const RMS_RATIO_ON = 1.55;
const CV_DROP_ON = 0.1;
const APPEAR_ON = 0.4;
const AUDIO_ON = 0.4;
const APPEAR_STRONG = 0.7;
const ENCODE_ON = 0.55;
/** 有 unlike/encode 锚点时，HIGH 与最终 pick 须落在此半径内（与 snap / audio-lock 一致） */
const VISUAL_ANCHOR_ALIGN = 90;

function clip01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const v of xs) s += (v - m) * (v - m);
  return Math.sqrt(s / xs.length);
}

function annotate(series: TimedFeature[]): Tile[] {
  return series.map((x, i) => {
    const nxt = series[i + 1] ?? x;
    return { ...x, selfSim: featureSimilarity(x.fp, nxt.fp) };
  });
}

function visWindow(tiles: Tile[], t0: number, t1: number, key: (x: Tile) => number): number | null {
  const vs: number[] = [];
  for (const x of tiles) {
    if (x.t >= t0 && x.t < t1) vs.push(key(x));
  }
  return vs.length >= 3 ? mean(vs) : null;
}

function bodyProto(tiles: Tile[], duration: number): { body: FrameFeatures; bodyMean: number } | null {
  let src = tiles.filter((x) => x.t >= duration * 0.08 && x.t <= duration * 0.4);
  if (src.length < 8) src = tiles.slice(0, Math.max(8, Math.floor(tiles.length / 8)));
  const step = Math.max(1, Math.floor(src.length / 20));
  const chunk = src.filter((_, i) => i % step === 0);
  const body = averageFeatures(chunk.map((x) => x.fp));
  if (!body || !chunk.length) return null;
  const bodyMean = mean(chunk.map((x) => featureSimilarity(x.fp, body)));
  return { body, bodyMean };
}

function recoveredVisual(tiles: Tile[], t: number, cover: number, body: FrameFeatures, bodyMean: number): boolean {
  const until = Math.min(cover, t + SUSTAIN_SEC);
  let tscan = t + 120;
  while (tscan < until - 50) {
    const vals: number[] = [];
    for (const x of tiles) {
      if (x.t >= tscan && x.t < tscan + 90) vals.push(featureSimilarity(x.fp, body));
    }
    if (vals.length >= 3 && mean(vals) >= bodyMean - 0.03) return true;
    tscan += 30;
  }
  return false;
}

type UnlikeSeg = { t0: number; t1: number };

function unlikeSegments(tiles: Tile[], body: FrameFeatures, bodyMean: number, cover: number): UnlikeSeg[] {
  const flags = tiles.map((x) => featureSimilarity(x.fp, body) <= bodyMean - UNLIKE_SLACK);
  const segs: UnlikeSeg[] = [];
  let i = 0;
  const n = flags.length;
  while (i < n) {
    if (!flags[i]) {
      i += 1;
      continue;
    }
    let j = i;
    let miss = 0;
    let lastHit = i;
    while (j < n) {
      if (flags[j]) {
        lastHit = j;
        miss = 0;
      } else {
        miss += 1;
        if (miss > 2) break;
      }
      j += 1;
    }
    const t0 = tiles[i]!.t;
    const t1 = tiles[lastHit]!.t;
    if (t1 - t0 >= UNLIKE_MIN_LEN && !recoveredVisual(tiles, t0, cover, body, bodyMean)) {
      segs.push({ t0, t1 });
    }
    i = lastHit + 1;
  }
  return segs;
}

function meanSelfSim(tiles: Tile[], t0: number, t1: number): number | null {
  return visWindow(tiles, t0, t1, (x) => x.selfSim);
}

/** 起点后短窗已是高 selfSim 静态垫片（真·片尾空镜），而非仍在切镜的后期正文。 */
function looksLikeStaticPad(tiles: Tile[], t: number): boolean {
  const post = meanSelfSim(tiles, t, t + PAD_SELF_LOOK);
  return post != null && post >= PAD_SELF_MIN;
}

function isStaticPadOnset(tiles: Tile[], t: number): boolean {
  const pre = meanSelfSim(tiles, t - PAD_SELF_LOOK, t);
  const post = meanSelfSim(tiles, t, t + PAD_SELF_LOOK);
  return pre != null && post != null && post >= PAD_SELF_MIN && post - pre >= PAD_SELF_RISE;
}

/**
 * 接到片尾的长 unlike 常把「中后段正文域偏移」与真正风光垫片并成一段。
 * 若最早 snap 处还不是静态垫片，则前移到段内最早的静态垫片起点。
 */
function refineUnlikeToEndStart(tiles: Tile[], seg: UnlikeSeg, cover: number, provisional: number): number {
  if (cover - seg.t1 > UNLIKE_TO_END_SLACK) return seg.t0;
  if (looksLikeStaticPad(tiles, provisional)) return seg.t0;
  const hi = Math.min(seg.t1, cover - UNLIKE_MIN_LEN);
  for (const x of tiles) {
    if (x.t < seg.t0 || x.t > hi) continue;
    if (isStaticPadOnset(tiles, x.t)) return x.t;
  }
  return seg.t0;
}

function snapUnlikeStart(tiles: Tile[], body: FrameFeatures, t0: number): number {
  const win = tiles.filter((x) => x.t >= t0 && x.t <= t0 + UNLIKE_NEAR);
  let hit = t0;
  let best = 0;
  for (let i = 1; i < win.length; i++) {
    const a = win[i - 1]!;
    const b = win[i]!;
    const drop = featureSimilarity(a.fp, body) - featureSimilarity(b.fp, body);
    const score = drop + 0.5 * Math.abs(b.fp.meanLuma - a.fp.meanLuma);
    if (score > best) {
      best = score;
      hit = b.t;
    }
  }
  return best >= 0.08 ? hit : t0;
}

/** 解析 unlike 锚点：to-end 段先按静态垫片收紧，再局部 snap。 */
function resolveUnlikeAnchors(
  tiles: Tile[],
  body: FrameFeatures,
  bodyMean: number,
  cover: number,
): { starts: number[]; snapped: number | null; padAnchored: boolean } {
  const segs = unlikeSegments(tiles, body, bodyMean, cover);
  if (!segs.length) return { starts: [], snapped: null, padAnchored: false };
  const starts: number[] = [];
  /** 接到片尾的 refined 起点 */
  let toEndStart: number | null = null;
  for (const seg of segs) {
    const provisional = snapUnlikeStart(tiles, body, seg.t0);
    const refined = refineUnlikeToEndStart(tiles, seg, cover, provisional);
    starts.push(refined);
    if (cover - seg.t1 <= UNLIKE_TO_END_SLACK) {
      if (toEndStart == null || refined < toEndStart) toEndStart = refined;
    }
  }
  // 仅当 to-end 已是静态垫片时以其为 snap（多段中段域偏移 + 真垫片）。
  // 非垫片的片尾 stub（长片中后另有主 unlike）仍回退最早 unlike，避免锁到末段噪声。
  const toEndPad = toEndStart != null && looksLikeStaticPad(tiles, toEndStart);
  const snapBase = toEndPad ? toEndStart! : Math.min(...starts);
  const snapped = snapUnlikeStart(tiles, body, snapBase);
  return { starts, snapped, padAnchored: looksLikeStaticPad(tiles, snapped) };
}

function findEncodeOnset(index: number[] | undefined, duration: number): number | null {
  if (!index || index.length < 40) return null;
  const dts: { t: number; dt: number }[] = [];
  for (let i = 0; i < index.length - 1; i++) {
    const a = index[i]!;
    const b = index[i + 1]!;
    if (b > a) dts.push({ t: a, dt: b - a });
  }
  if (dts.length < 30) return null;
  const early = median(dts.slice(0, Math.max(20, dts.length >> 2)).map((x) => x.dt));
  if (early < 1) return null;
  const win = 8;
  for (let i = 0; i < dts.length - win; i++) {
    const t = dts[i]!.t;
    if (t < 480) continue;
    if (duration - t < 60) break;
    const window = dts.slice(i, i + win);
    const high = window.filter((x) => x.dt >= early * 1.22).length;
    if (high < win * 0.55) continue;
    const rest = median(dts.slice(i).map((x) => x.dt));
    if (rest < early * 1.12) continue;
    return t;
  }
  return null;
}

function encodeScoreAt(onset: number | null, t: number): number {
  if (onset == null) return 0;
  const d = t - onset;
  if (d < -20 || d > 48) return 0;
  return clip01(1 - Math.abs(d) / 50);
}

function wmean(
  feat: AudioFeat | null | undefined,
  t0: number,
  t1: number,
  key: keyof Pick<AudioProbe, "rms" | "zcr" | "centroid" | "flatness">,
  minN = 2,
): number | null {
  if (!feat) return null;
  const vs = feat.points.filter((p) => p.t >= t0 && p.t < t1).map((p) => p[key] ?? 0);
  return vs.length >= minN ? mean(vs) : null;
}

function wstdRms(feat: AudioFeat, t0: number, t1: number): number | null {
  const vs = feat.points.filter((p) => p.t >= t0 && p.t < t1).map((p) => p.rms);
  return vs.length >= 2 ? stdev(vs) : null;
}

function suffixIsPad(feat: AudioFeat, t: number): boolean {
  const z = wmean(feat, t + 60, t + SUSTAIN_SEC, "zcr");
  const c = wmean(feat, t + 60, t + SUSTAIN_SEC, "centroid");
  return z != null && z <= 0.028 && c != null && c <= 850;
}

function recoveredAudio(feat: AudioFeat, t: number): boolean {
  let tscan = t + 120;
  const until = Math.min(feat.n - 1, t + SUSTAIN_SEC);
  while (tscan < until - 50) {
    const burst = wmean(feat, tscan, tscan + 90, "zcr");
    const stay = wmean(feat, tscan + 90, tscan + 270, "zcr");
    if (burst != null && burst >= ZCR_SPEECH_BURST && stay != null && stay >= ZCR_SPEECH) return true;
    tscan += 30;
  }
  return false;
}

interface Hit {
  t: number;
  appear: number;
  audio: number;
  encode: number;
}

interface Ctx {
  tiles: Tile[];
  body: FrameFeatures | null;
  bodyMean: number;
  unlikeStarts: number[];
  unlikeSnapped: number | null;
  /** 当前 snap 处已是静态垫片：选池优先围着该锚点，避免早段正文域偏移的强 appear 抢赢 */
  padAnchored: boolean;
  encodeOnset: number | null;
}

function prepareCtx(input: JointDetectInput): Ctx {
  const tiles = annotate(input.series);
  const cover = input.coverageEnd || (tiles.length ? tiles[tiles.length - 1]!.t : input.duration);
  let body: FrameFeatures | null = null;
  let bodyMean = 0;
  let unlikeStarts: number[] = [];
  let unlikeSnapped: number | null = null;
  let padAnchored = false;
  if (tiles.length) {
    const proto = bodyProto(tiles, input.duration);
    if (proto) {
      body = proto.body;
      bodyMean = proto.bodyMean;
      const resolved = resolveUnlikeAnchors(tiles, body, bodyMean, cover);
      unlikeStarts = resolved.starts;
      unlikeSnapped = resolved.snapped;
      padAnchored = resolved.padAnchored;
    }
  }
  const encodeOnset = findEncodeOnset(input.keyframeTimes, input.duration);
  return { tiles, body, bodyMean, unlikeStarts, unlikeSnapped, padAnchored, encodeOnset };
}

function scoreAt(input: JointDetectInput, t: number, ctx: Ctx): Hit {
  const cover = input.coverageEnd || input.duration;
  let appear = 0;
  let staticPart = 0;
  if (ctx.tiles.length && ctx.body) {
    const preB = visWindow(ctx.tiles, t - PRE_SEC, t, (x) => featureSimilarity(x.fp, ctx.body!));
    const postB = visWindow(ctx.tiles, t, t + POST_SEC, (x) => featureSimilarity(x.fp, ctx.body!));
    const preS = visWindow(ctx.tiles, t - PRE_SEC, t, (x) => x.selfSim);
    const postS = visWindow(ctx.tiles, t, t + SUSTAIN_SEC, (x) => x.selfSim);
    let bodyPart = 0;
    let unlikePart = 0;
    if (preB != null && postB != null) {
      const drop = preB - postB;
      if (drop >= BODY_DROP_ON && preB >= ctx.bodyMean - 0.05) bodyPart = clip01(drop / BODY_DROP_FULL);
    }
    if (preS != null && postS != null) {
      const rise = postS - preS;
      if (postS >= STATIC_POST && rise >= STATIC_RISE) staticPart = 0.55 * clip01(rise / STATIC_RISE_FULL);
    }
    if (ctx.unlikeStarts.length) {
      let near = ctx.unlikeStarts[0]!;
      let best = Math.abs(near - t);
      for (const u of ctx.unlikeStarts) {
        const d = Math.abs(u - t);
        if (d < best) {
          best = d;
          near = u;
        }
      }
      if (best <= UNLIKE_NEAR) unlikePart = 0.45;
    }
    if (recoveredVisual(ctx.tiles, t, cover, ctx.body, ctx.bodyMean)) {
      bodyPart = 0;
      unlikePart = 0;
    }
    // 用 snap（优先 to-end）清静态，勿用最早 mid-unlike，否则片尾垫片段 static 会被误清
    const staticClearAt = ctx.unlikeSnapped ?? (ctx.unlikeStarts.length ? Math.min(...ctx.unlikeStarts) : null);
    if (staticClearAt != null && t > staticClearAt + UNLIKE_NEAR) {
      staticPart = 0;
    }
    appear = Math.min(1, bodyPart + staticPart + unlikePart);
  }

  let audio = 0;
  const feat = input.audio;
  if (feat) {
    const zp = wmean(feat, t - PRE_SEC, t, "zcr");
    const zq = wmean(feat, t, t + POST_SEC, "zcr");
    const cp = wmean(feat, t - PRE_SEC, t, "centroid");
    const cq = wmean(feat, t, t + POST_SEC, "centroid");
    const rp = wmean(feat, t - PRE_SEC, t, "rms");
    const rq = wmean(feat, t, t + POST_SEC, "rms");
    const sp = wstdRms(feat, t - PRE_SEC, t);
    const sq = wstdRms(feat, t, t + POST_SEC);
    if (zp != null && zq != null && zp >= ZCR_PRE_MIN && zq <= ZCR_POST_MAX) {
      const drop = zp - zq;
      if (drop >= ZCR_DROP_ON) audio += clip01(drop / ZCR_DROP_FULL);
    }
    if (cp != null && cq != null && cp >= CEN_PRE_MIN && cq <= CEN_POST_MAX) {
      const drop = cp - cq;
      if (drop >= CEN_DROP_ON) audio += 0.55 * clip01(drop / CEN_DROP_FULL);
    }
    if (rp != null && rq != null && sp != null && sq != null && rp > 1e-4) {
      const cvp = sp / rp;
      const cvq = sq / Math.max(rq, 1e-4);
      if (rq >= rp * RMS_RATIO_ON && cvp - cvq >= CV_DROP_ON) {
        audio += 0.45 * clip01((rq / rp - 1.2) / 1.5 + (cvp - cvq - 0.08) / 0.25);
      }
    }
    // 播放中稀疏波形：正文对照 + 切点后是否像垫乐/空镜声
    const bodyZ =
      wmean(feat, t - PRE_SEC, t, "zcr", 1) ?? wmean(feat, Math.max(60, t - 360), t - 45, "zcr", 1);
    const padZ = wmean(feat, t, t + POST_SEC, "zcr", 1) ?? wmean(feat, t, t + 90, "zcr", 1);
    const bodyC =
      wmean(feat, t - PRE_SEC, t, "centroid", 1) ?? wmean(feat, Math.max(60, t - 360), t - 45, "centroid", 1);
    const padC = wmean(feat, t, t + POST_SEC, "centroid", 1) ?? wmean(feat, t, t + 90, "centroid", 1);
    if (bodyZ != null && padZ != null && padZ <= 0.036 && bodyZ - padZ >= 0.012) {
      audio += clip01((bodyZ - padZ) / 0.04);
    }
    if (bodyC != null && padC != null && padC <= 1300 && bodyC - padC >= 150) {
      audio += 0.45 * clip01((bodyC - padC) / 500);
    }
    if (ctx.unlikeSnapped != null && Math.abs(ctx.unlikeSnapped - t) <= 90) {
      const locked = feat.points.filter(
        (p) =>
          p.t >= ctx.unlikeSnapped! &&
          p.t <= ctx.unlikeSnapped! + 90 &&
          p.zcr <= 0.036 &&
          (p.centroid <= 1300 || (p.flatness ?? 1) <= 0.4),
      );
      if (locked.length >= 2) audio += 0.5;
    }
    audio = Math.min(1, audio);
    if (recoveredAudio(feat, t)) audio *= 0.15;
    if (!input.series.length && !suffixIsPad(feat, t)) audio *= 0.15;
  }

  return { t, appear, audio, encode: encodeScoreAt(ctx.encodeOnset, t) };
}

function nCh(h: Hit): number {
  return (h.appear >= APPEAR_ON ? 1 : 0) + (h.audio >= AUDIO_ON ? 1 : 0) + (h.encode >= ENCODE_ON ? 1 : 0);
}

function jointStrength(h: Hit): [number, number] {
  const n = nCh(h);
  const agree = h.appear * Math.max(h.audio, 0.55 * h.encode);
  if (n >= 2) return [2 + agree, h.appear + h.audio + h.encode];
  return [h.appear + h.audio + 0.6 * h.encode, 0];
}

function clusterHits(hits: Hit[]): Hit[][] {
  if (!hits.length) return [];
  const sorted = [...hits].sort((a, b) => a.t - b.t);
  const out: Hit[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    const h = sorted[i]!;
    const last = out[out.length - 1]!;
    if (h.t - last[last.length - 1]!.t > CLUSTER_GAP) out.push([h]);
    else last.push(h);
  }
  return out;
}

function clusterCenter(cl: Hit[]): Hit & { agree: number; n: number } {
  let best = cl[0]!;
  let bestS = jointStrength(best);
  for (const h of cl) {
    const s = jointStrength(h);
    if (s[0] > bestS[0] || (s[0] === bestS[0] && s[1] > bestS[1])) {
      best = h;
      bestS = s;
    }
  }
  const agreed = cl.filter((h) => nCh(h) >= 2).map((h) => h.t);
  const t = agreed.length ? median(agreed) : best.t;
  let near = cl[0]!;
  let nd = Math.abs(near.t - t);
  for (const h of cl) {
    const d = Math.abs(h.t - t);
    if (d < nd) {
      nd = d;
      near = h;
    }
  }
  return {
    ...near,
    t,
    agree: near.appear * Math.max(near.audio, 0.55 * near.encode),
    n: cl.length,
  };
}

function hasVisualAnchor(ctx: Ctx, duration: number): boolean {
  if (ctx.unlikeSnapped != null || ctx.unlikeStarts.length > 0) return true;
  return ctx.encodeOnset != null && ctx.encodeOnset >= duration * 0.28;
}

function visualAligned(t: number, ctx: Ctx): boolean {
  if (ctx.unlikeSnapped != null && Math.abs(t - ctx.unlikeSnapped) <= VISUAL_ANCHOR_ALIGN) return true;
  for (const u of ctx.unlikeStarts) {
    if (Math.abs(t - u) <= UNLIKE_NEAR) return true;
  }
  if (ctx.encodeOnset != null) {
    const d = t - ctx.encodeOnset;
    if (d >= -20 && d <= 48) return true;
  }
  return false;
}

function confidenceOf(
  c: Hit,
  hasVisual: boolean,
  hasAudio: boolean,
  ctx: Ctx,
  duration: number,
): { level: ConfLevel; confidence: number } {
  const n = nCh(c);
  if (n >= 2) {
    // 已采到音频时，HIGH 必须含音频路，避免 appear+encode 单独落盘误跳
    if (hasAudio && c.audio < AUDIO_ON) {
      if (c.appear >= APPEAR_STRONG) {
        return { level: "MED", confidence: 0.64 + 0.1 * Math.min(1, c.appear - APPEAR_STRONG) };
      }
      return { level: "LOW", confidence: 0.4 + 0.1 * Math.max(c.appear, c.encode) };
    }
    // 有画面锚点时：弱 appear + 纯音频假阳性不得 HIGH，须与 snap/强 unlike 对齐
    if (
      hasVisual &&
      hasVisualAnchor(ctx, duration) &&
      c.appear < APPEAR_STRONG &&
      c.encode < ENCODE_ON &&
      !visualAligned(c.t, ctx)
    ) {
      return { level: "MED", confidence: 0.55 + 0.12 * Math.min(1, c.audio) };
    }
    return {
      level: "HIGH",
      confidence: 0.82 + 0.08 * Math.min(1, n - 2) + 0.05 * Math.min(c.appear, Math.max(c.audio, c.encode)),
    };
  }
  if (c.appear >= APPEAR_STRONG && (!hasAudio || c.audio < 0.25)) {
    return { level: "MED", confidence: 0.62 + 0.12 * (c.appear - APPEAR_STRONG) };
  }
  if (c.audio >= AUDIO_ON && !hasVisual) {
    return { level: "MED", confidence: 0.58 + 0.15 * Math.min(1, c.audio) };
  }
  return { level: "LOW", confidence: 0.35 + 0.15 * Math.max(c.appear, c.audio) };
}

/** 音频探针应围着这些画面/编码事件，而不是只围最终 pick。 */
export function visualProbeCenters(input: JointDetectInput): number[] {
  const ctx = prepareCtx(input);
  const out = [...ctx.unlikeStarts];
  if (ctx.unlikeSnapped != null) out.push(ctx.unlikeSnapped);
  if (ctx.encodeOnset != null && ctx.encodeOnset >= input.duration * 0.28) out.push(ctx.encodeOnset);
  return out;
}

export function detectJoint(input: JointDetectInput): JointDetectResult {
  const duration = input.duration;
  let cover = input.series.length ? input.coverageEnd : duration;
  if (input.audio) cover = Math.max(cover, Math.min(input.audio.n - 1, duration));
  const hasVisual = input.series.length > 0;
  const hasAudio = !!input.audio;
  const empty = (reason: string, level: ConfLevel, confidence = 0): JointDetectResult => ({
    found: false,
    fillerStart: null,
    duration,
    reason,
    confidence,
    level,
    probeCenters: visualProbeCenters(input),
  });

  if (!hasVisual && !hasAudio) return empty("无信号", "NONE");

  const ctx = prepareCtx(input);
  const lo = SUSTAIN_SEC;
  const hi = Math.min(cover, duration) - SUSTAIN_SEC;
  if (hi <= lo) return empty("视频过短", "NONE");

  const hits: Hit[] = [];
  for (let t = lo; t <= hi; t += STEP) {
    const h = scoreAt(input, t, ctx);
    if (h.appear >= APPEAR_ON || h.audio >= AUDIO_ON || h.encode >= ENCODE_ON) hits.push(h);
  }

  type Cl = Hit & { agree: number; n: number; level: ConfLevel; confidence: number };
  const clusters: Cl[] = [];
  for (const cl of clusterHits(hits)) {
    const c = clusterCenter(cl);
    const { level, confidence } = confidenceOf(c, hasVisual, hasAudio, ctx, duration);
    clusters.push({ ...c, level, confidence });
  }

  const usable = clusters.filter((c) => c.level === "HIGH" || c.level === "MED");
  if (!usable.length) return empty("置信不足，弃权", "LOW");

  // 有画面锚点时：丢掉「弱 appear + 远离所有 unlike/encode」的候选，避免早段音频假阳性压过后期真切点。
  // 已有静态垫片 snap 时：选池只围 to-end 垫片锚点（勿用全部 unlikeStarts，中段域偏移会漏进池）。
  const anchored = (t: number) => visualAligned(t, ctx);
  const nearPad =
    ctx.padAnchored && ctx.unlikeSnapped != null
      ? usable.filter((c) => Math.abs(c.t - ctx.unlikeSnapped!) <= VISUAL_ANCHOR_ALIGN)
      : [];
  const prefer = nearPad.length
    ? nearPad
    : hasVisual && hasVisualAnchor(ctx, duration)
      ? usable.filter((c) => anchored(c.t) || c.appear >= APPEAR_STRONG)
      : usable;
  const poolBase = prefer.length ? prefer : usable;
  const high = poolBase.filter((c) => c.level === "HIGH");
  const pool = high.length ? high : poolBase;
  let pick = pool[0]!;
  for (const c of pool) {
    if (c.agree > pick.agree || (c.agree === pick.agree && c.appear + c.audio > pick.appear + pick.audio)) {
      pick = c;
    } else if (c.agree === pick.agree && c.appear + c.audio === pick.appear + pick.audio && c.t > pick.t) {
      pick = c;
    }
  }

  const snap = ctx.unlikeSnapped;
  const usedUnlike = snap != null && Math.abs(snap - pick.t) <= 90;
  let tPick = pick.t;
  const parts: string[] = [];
  if (usedUnlike && snap != null) {
    tPick = snap;
    parts.push("snap-unlike");
  }
  const feat = input.audio;
  if (!usedUnlike && pick.encode >= ENCODE_ON && ctx.encodeOnset != null && feat) {
    const locked = feat.points
      .filter((p) => p.t >= ctx.encodeOnset! && p.t <= ctx.encodeOnset! + 60 && p.zcr <= ZCR_POST_MAX)
      .map((p) => p.t);
    if (locked.length) {
      tPick = Math.min(...locked);
      parts.push("encode-lock");
    }
  }
  if (!hasVisual && feat) {
    const locked = feat.points
      .filter((p) => p.t >= tPick - 90 && p.t <= tPick + 90 && p.zcr <= ZCR_POST_MAX && p.centroid <= 850)
      .map((p) => p.t);
    if (locked.length) {
      tPick = Math.min(...locked);
      parts.push("audio-lock");
    }
  }

  const probeCenters = [
    ...ctx.unlikeStarts,
    ...(ctx.unlikeSnapped != null ? [ctx.unlikeSnapped] : []),
    ...(ctx.encodeOnset != null && ctx.encodeOnset >= duration * 0.28 ? [ctx.encodeOnset] : []),
    ...clusters.filter((c) => c.level === "HIGH" || c.level === "MED").map((c) => c.t),
  ];

  return {
    found: pick.level === "HIGH",
    fillerStart: tPick,
    duration,
    reason: `${pick.level} a=${pick.appear.toFixed(2)} u=${pick.audio.toFixed(2)} e=${pick.encode.toFixed(2)} ${parts.join(",")}`,
    confidence: pick.confidence,
    level: pick.level,
    probeCenters,
  };
}
