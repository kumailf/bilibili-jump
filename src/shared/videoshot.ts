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

export async function fetchVideoshotFromBackground(
  bvid: string,
  page: number,
): Promise<VideoshotPayload | null> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "loadVideoshot",
      bvid,
      page,
    });
    if (!res?.ok || !res.data) return null;
    return res.data as VideoshotPayload;
  } catch {
    return null;
  }
}

function isBlankTile(fp: FrameFeatures): boolean {
  return fp.meanLuma < 0.04 && fp.edgeEnergy < 0.05;
}

/** 把雪碧图拆成按时间对齐的指纹序列 */
export async function featuresFromVideoshot(
  payload: VideoshotPayload,
  duration: number,
): Promise<TimedFeature[]> {
  const { img_x_len, img_y_len, img_x_size, img_y_size, index, sheets } = payload;
  if (!sheets.length || img_x_len < 1 || img_y_len < 1) return [];

  const perSheet = img_x_len * img_y_len;
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const out: TimedFeature[] = [];

  for (let s = 0; s < sheets.length; s++) {
    const blob = new Blob([sheets[s]!]);
    const bmp = await createImageBitmap(blob);
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
      const t =
        Array.isArray(index) && index.length > frameIndex + 1
          ? Number(index[frameIndex + 1])
          : (frameIndex / Math.max(1, sheets.length * perSheet - 1)) * Math.max(1, duration - 1);
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
  return async (timeSec: number) => {
    let best = series[0]!;
    let bestD = Math.abs(best.t - timeSec);
    for (let i = 1; i < series.length; i++) {
      const d = Math.abs(series[i]!.t - timeSec);
      if (d < bestD) {
        best = series[i]!;
        bestD = d;
      }
    }
    return best.fp;
  };
}
