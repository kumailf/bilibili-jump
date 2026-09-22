/** 分析生命周期超时。watchdog 必须 ≥ fetch，避免双跑。 */

export type AnalyzeStage =
  | "idle"
  | "ready"
  | "fetch"
  | "decode"
  | "visual"
  | "audio-pending"
  | "med"
  | "high"
  | "cache"
  | "abstain"
  | "fail";

export const ANALYZE_TIMEOUTS = {
  readyMs: 5_000,
  /** 拉雪碧图（含逐张下载） */
  fetchMs: 60_000,
  analyzeMs: 30_000,
  /** 有画面结果时续期，不清空 */
  pendingExpireMs: 180_000,
  /** 必须 > fetchMs，超时才 abort 旧任务 */
  runWatchdogMs: 90_000,
  /** 进度条父节点未就绪时重试 */
  paintRetryMs: 800,
} as const;

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}
