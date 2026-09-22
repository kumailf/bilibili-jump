import { featuresFromRgba, SAMPLE_SIZE, type FrameFeatures } from "./fingerprint";
import type { FrameSampler } from "./video-sampler";

export interface VideoshotPayload {
  img_x_len: number;
  img_y_len: number;
  img_x_size: number;
  img_y_size: number;
  index: number[];
  /** 雪碧图 JPEG/PNG 字节 */
  sheets: ArrayBuffer[];
}

export interface TimedFeature {
  t: number;
  fp: FrameFeatures;
}

/** index 至少覆盖大部分格子，且末尾时间靠近片长，才可用来对齐。 */
export function hasUsableVideoshotIndex(
  index: number[] | undefined,
  sheetCount: number,
  perSheet: number,
  duration: number,
): boolean {
  if (!Array.isArray(index) || index.length < 12) return false;
  const capacity = Math.max(1, sheetCount * perSheet);
  if (index.length < capacity * 0.55) return false;
  const times = index.map(Number).filter((t) => Number.isFinite(t) && t >= 0);
  if (times.length < 12) return false;
  let mono = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i]! >= times[i - 1]!) mono += 1;
  }
  if (mono / (times.length - 1) < 0.9) return false;
  const last = times[times.length - 1]!;
  if (duration > 120 && last < duration * 0.55) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function fetchSheetBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await chrome.runtime.sendMessage({ type: "fetchSheet", url });
    if (!res?.ok || typeof res.b64 !== "string" || !res.b64) return null;
    return base64ToArrayBuffer(res.b64);
  } catch {
    return null;
  }
}

/**
 * 拉雪碧图元数据 + 逐张下图。
 * 不经过 message 传巨大 ArrayBuffer（实测会得到 0 帧）。
 */
export async function fetchVideoshotWithIndex(
  bvid: string,
  page: number,
  duration: number,
): Promise<VideoshotPayload | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let meta: {
      img_x_len: number;
      img_y_len: number;
      img_x_size: number;
      img_y_size: number;
      index: number[];
      imageUrls: string[];
    } | null = null;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "loadVideoshotMeta",
        bvid,
        page,
      });
      if (res?.ok && res.data) meta = res.data;
    } catch {
      meta = null;
    }
    if (!meta?.imageUrls?.length) {
      if (attempt === 0) await sleep(350);
      continue;
    }

    const sheets: ArrayBuffer[] = [];
    for (const url of meta.imageUrls) {
      const buf = await fetchSheetBytes(url);
      if (buf) sheets.push(buf);
    }
    if (!sheets.length) {
      if (attempt === 0) await sleep(350);
      continue;
    }

    const perSheet = Math.max(1, meta.img_x_len * meta.img_y_len);
    if (!hasUsableVideoshotIndex(meta.index, sheets.length, perSheet, duration)) {
      if (attempt === 0) await sleep(450);
      continue;
    }

    return {
      img_x_len: meta.img_x_len,
      img_y_len: meta.img_y_len,
      img_x_size: meta.img_x_size,
      img_y_size: meta.img_y_size,
      index: meta.index,
      sheets,
    };
  }
  return null;
}

function isBlankTile(fp: FrameFeatures): boolean {
  return fp.meanLuma < 0.04 && fp.edgeEnergy < 0.05;
}

/** 把雪碧图拆成按时间对齐的指纹序列；无可用 index 时返回空（不线性估时）。 */
export async function featuresFromVideoshot(
  payload: VideoshotPayload,
  duration: number,
): Promise<TimedFeature[]> {
  const { img_x_len, img_y_len, img_x_size, img_y_size, index, sheets } = payload;
  if (!sheets.length || img_x_len < 1 || img_y_len < 1) return [];

  const perSheet = img_x_len * img_y_len;
  if (!hasUsableVideoshotIndex(index, sheets.length, perSheet, duration)) return [];

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const out: TimedFeature[] = [];

  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s]!;
    if (!sheet.byteLength) continue;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(new Blob([sheet]));
    } catch {
      continue;
    }
    for (let k = 0; k < perSheet; k++) {
      const col = k % img_x_len;
      const row = Math.floor(k / img_x_len);
      const sx = col * img_x_size;
      const sy = row * img_y_size;
      if (sx + img_x_size > bmp.width + 1 || sy + img_y_size > bmp.height + 1) continue;
      ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      ctx.drawImage(bmp, sx, sy, img_x_size, img_y_size, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const fp = featuresFromRgba(data, SAMPLE_SIZE, SAMPLE_SIZE);
      if (isBlankTile(fp)) continue;
      const frameIndex = s * perSheet + k;
      if (frameIndex >= index.length) continue;
      // 契约：第 frameIndex 格对齐 index[frameIndex]（秒）。禁止线性估时。
      const t = Number(index[frameIndex]);
      if (!Number.isFinite(t) || t < 0) continue;
      out.push({ t: Math.min(t, Math.max(0, duration - 0.05)), fp });
    }
    bmp.close();
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

export function createSeriesSampler(series: TimedFeature[]): FrameSampler {
  if (!series.length) {
    return async () => null;
  }
  const sorted = [...series].sort((a, b) => a.t - b.t);
  return async (timeSec: number) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.t <= timeSec) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return sorted[idx]!.fp;
  };
}
