import { SAMPLE_SIZE, featuresFromRgba, type FrameFeatures } from "./fingerprint";

export type FrameSampler = (timeSec: number) => Promise<FrameFeatures | null>;

export interface SeekSampler {
  (timeSec: number): Promise<FrameFeatures | null>;
  restore: () => Promise<void>;
  originTime: number;
  wasPaused: boolean;
  clearCache: () => void;
}

/**
 * 带时间量化缓存的 seek 抽帧器。
 * 粗扫大量重复点时复用缓存，降低 seek 次数。
 */
export function createSeekSampler(video: HTMLVideoElement): SeekSampler {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const originTime = video.currentTime;
  const wasPaused = video.paused;
  const cache = new Map<number, FrameFeatures>();

  const quantize = (t: number) => Math.round(t * 2) / 2;

  const seekTo = (timeSec: number) =>
    new Promise<void>((resolve, reject) => {
      const target = Math.min(Math.max(0, timeSec), Math.max(0, video.duration - 0.05));
      if (Math.abs(video.currentTime - target) < 0.05 && video.readyState >= 2) {
        resolve();
        return;
      }
      let done = false;
      const timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      }, 2800);
      const onSeeked = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const onErr = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("video seek error"));
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onErr);
      };
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onErr);
      try {
        video.currentTime = target;
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

  const sample = (async (timeSec: number) => {
    if (!ctx || !Number.isFinite(video.duration) || video.readyState < 1) return null;
    const key = quantize(timeSec);
    const hit = cache.get(key);
    if (hit) return hit;
    try {
      await seekTo(key);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      ctx.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const feat = featuresFromRgba(data, SAMPLE_SIZE, SAMPLE_SIZE);
      cache.set(key, feat);
      return feat;
    } catch {
      return null;
    }
  }) as SeekSampler;

  sample.originTime = originTime;
  sample.wasPaused = wasPaused;
  sample.clearCache = () => cache.clear();
  sample.restore = async () => {
    try {
      await seekTo(originTime);
      if (!wasPaused) await video.play().catch(() => undefined);
      else video.pause();
    } catch {
      /* ignore */
    }
  };

  return sample;
}
