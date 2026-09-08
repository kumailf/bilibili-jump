import { DETECT_DEFAULTS } from "./storage";

/** 从起点起连续已缓冲秒数 */
export function bufferedFromStart(video: HTMLVideoElement): number {
  const ranges = video.buffered;
  if (!ranges.length || !Number.isFinite(video.duration)) return 0;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= 0.35) return ranges.end(i);
  }
  return 0;
}

function isPlayable(video: HTMLVideoElement): boolean {
  return Number.isFinite(video.duration) && video.duration > 1 && video.readyState >= 2;
}

/**
 * 等到「开播缓冲已稳住」：有时长、前面已缓存一段、且用户已正常看了一小会儿。
 * 不会 pause/seek。超时则返回 false。
 */
export function waitUntilSafeToAnalyze(
  video: HTMLVideoElement,
  opts?: { signal?: AbortSignal },
): Promise<boolean> {
  const minPlayed = DETECT_DEFAULTS.minPlayedSeconds;
  const minBuffered = Math.min(
    DETECT_DEFAULTS.minBufferedSeconds,
    Math.max(8, video.duration * 0.04 || DETECT_DEFAULTS.minBufferedSeconds),
  );
  const deadline = Date.now() + 180_000;

  return new Promise((resolve) => {
    let played = 0;
    let lastTs = 0;
    let raf = 0;
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(raf);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      opts?.signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };

    const onAbort = () => finish(false);

    const tick = () => {
      if (settled) return;
      if (opts?.signal?.aborted || Date.now() > deadline) {
        finish(false);
        return;
      }
      if (!video.paused && lastTs > 0) {
        played += (performance.now() - lastTs) / 1000;
      }
      lastTs = video.paused ? 0 : performance.now();

      const bufferedOk = bufferedFromStart(video) >= minBuffered || video.readyState >= 4;
      const playedOk = played >= minPlayed || (!video.paused && video.currentTime >= minPlayed);
      if (isPlayable(video) && bufferedOk && playedOk) {
        finish(true);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    const onPlaying = () => {
      lastTs = performance.now();
    };
    const onPause = () => {
      lastTs = 0;
    };

    opts?.signal?.addEventListener("abort", onAbort);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    if (!video.paused) lastTs = performance.now();
    raf = requestAnimationFrame(tick);
  });
}
