import { DETECT_DEFAULTS } from "./storage";

function isPlayable(video: HTMLVideoElement): boolean {
  return Number.isFinite(video.duration) && video.duration > 1 && video.readyState >= 2;
}

/**
 * 雪碧图分析不依赖当前 buffer：有片长即可。
 * setInterval 兜底，避免后台页 raf 停转。
 */
export function waitUntilSafeToAnalyze(
  video: HTMLVideoElement,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 5_000);
  const minT = DETECT_DEFAULTS.minPlayedSeconds;

  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearInterval(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };

    const onAbort = () => finish(false);

    const tick = () => {
      if (settled) return;
      if (opts?.signal?.aborted) {
        finish(false);
        return;
      }
      if (isPlayable(video) && (video.currentTime >= minT || video.readyState >= 3 || Date.now() > deadline)) {
        finish(true);
        return;
      }
      if (Date.now() > deadline) {
        finish(isPlayable(video));
      }
    };

    opts?.signal?.addEventListener("abort", onAbort);
    tick();
    timer = window.setInterval(tick, 200);
  });
}
