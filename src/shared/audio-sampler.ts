/**
 * 跟着播放头听当前波形：不 seek、不 pause、不改 muted/volume。
 * 优先 captureStream 复制轨道；只有 stream 接不上时才用 MediaElementSource。
 * 静音/对白空隙保持听 stream，不改路由。
 */

export interface AudioProbe {
  t: number;
  rms: number;
  zcr: number;
  centroid: number;
  /** 频谱平坦度 0–1，语音偏低、噪声偏高 */
  flatness: number;
  frames: number;
  sampleRate: number;
}

const FFT_SIZE = 2048;
const POLL_MS = 40;
const LIVE_GAP_SEC = 1;
const LIVE_HOLD_MS = 560;
const LIVE_TICK_MS = 1000;
const LIVE_MAX_POINTS = 720;

type VideoWithCapture = HTMLVideoElement & { captureStream?: () => MediaStream };

export interface LiveAudioStats {
  n: number;
  silentTicks: number;
  tap: "stream" | "element" | null;
  lastRms: number;
  lastZcr: number;
}

export interface LiveAudioCollector {
  points(): AudioProbe[];
  stats(): LiveAudioStats;
  dispose(): void;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : 0.5 * (a[m - 1]! + a[m]!);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

function clip01flat(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function readFrame(
  analyser: AnalyserNode,
  td: Float32Array<ArrayBuffer>,
  fd: Float32Array<ArrayBuffer>,
  sampleRate: number,
): { rms: number; zcr: number; centroid: number; flatness: number } {
  analyser.getFloatTimeDomainData(td);
  let energy = 0;
  let zc = 0;
  for (let i = 0; i < td.length; i++) energy += td[i]! * td[i]!;
  for (let i = 1; i < td.length; i++) {
    if (td[i - 1]! >= 0 !== td[i]! >= 0) zc += 1;
  }
  const rms = Math.sqrt(energy / td.length);
  const zcr = zc / Math.max(1, td.length - 1);

  analyser.getFloatFrequencyData(fd);
  const binHz = sampleRate / analyser.fftSize;
  let num = 0;
  let den = 0;
  let logSum = 0;
  let magN = 0;
  for (let i = 1; i < fd.length; i++) {
    const hz = i * binHz;
    if (hz < 80) continue;
    if (hz > 4000) break;
    const mag = 10 ** (fd[i]! / 20);
    num += mag * hz;
    den += mag;
    if (mag > 1e-12) {
      logSum += Math.log(mag);
      magN += 1;
    }
  }
  const flatness = magN && den > 0 ? Math.exp(logSum / magN) / (den / magN) : 0;
  return { rms, zcr, centroid: den > 1e-12 ? num / den : 0, flatness: clip01flat(flatness) };
}

export function createLiveAudioCollector(
  video: HTMLVideoElement,
  onPoint?: () => void,
): LiveAudioCollector {
  const el = video as VideoWithCapture;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let td: Float32Array<ArrayBuffer> | null = null;
  let fd: Float32Array<ArrayBuffer> | null = null;
  let disposed = false;
  let busy = false;
  let timer = 0;
  let tap: LiveAudioStats["tap"] = null;
  let silentTicks = 0;
  let lastRms = 0;
  let lastZcr = 0;
  const acc: AudioProbe[] = [];

  const hookAnalyser = (node: AnalyserNode) => {
    analyser = node;
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    td = new Float32Array(analyser.fftSize);
    fd = new Float32Array(analyser.frequencyBinCount);
  };

  const ensure = async () => {
    if (disposed) throw new Error("live tap disposed");
    if (analyser && ctx) {
      if (ctx.state === "suspended") await ctx.resume();
      return;
    }
    ctx = new AudioContext();
    const node = ctx.createAnalyser();
    hookAnalyser(node);
    let hooked = false;
    if (typeof el.captureStream === "function") {
      try {
        stream = el.captureStream();
        if (stream.getAudioTracks().length) {
          ctx.createMediaStreamSource(stream).connect(node);
          tap = "stream";
          hooked = true;
        }
      } catch {
        stream = null;
      }
    }
    if (!hooked) {
      try {
        const src = ctx.createMediaElementSource(video);
        src.connect(node);
        node.connect(ctx.destination);
        tap = "element";
        hooked = true;
      } catch {
        /* 页面已占用 element source */
      }
    }
    if (!hooked) throw new Error("no audio tap");
    if (ctx.state === "suspended") await ctx.resume();
  };

  const tick = async () => {
    if (disposed || busy) return;
    if (video.paused || video.ended) return;
    if (video.readyState < 2) return;
    busy = true;
    try {
      await ensure();
      if (!analyser || !ctx || !td || !fd || disposed) return;
      const t0 = video.currentTime;
      if (acc.length && Math.abs(acc[acc.length - 1]!.t - t0) < LIVE_GAP_SEC * 0.6) return;
      const rs: number[] = [];
      const zs: number[] = [];
      const cs: number[] = [];
      const fs: number[] = [];
      const until = performance.now() + LIVE_HOLD_MS;
      while (performance.now() < until && !disposed && !video.paused) {
        const f = readFrame(analyser, td, fd, ctx.sampleRate);
        if (f.rms > 1e-6) {
          rs.push(f.rms);
          zs.push(f.zcr);
          cs.push(f.centroid);
          fs.push(f.flatness);
        }
        await sleep(POLL_MS);
      }
      if (rs.length < 3) {
        silentTicks += 1;
        return;
      }
      silentTicks = 0;
      const probe: AudioProbe = {
        t: t0,
        rms: median(rs),
        zcr: median(zs),
        centroid: median(cs),
        flatness: median(fs),
        frames: rs.length,
        sampleRate: ctx.sampleRate,
      };
      lastRms = probe.rms;
      lastZcr = probe.zcr;
      acc.push(probe);
      if (acc.length > LIVE_MAX_POINTS) acc.splice(0, acc.length - LIVE_MAX_POINTS);
      onPoint?.();
    } catch {
      silentTicks += 1;
    } finally {
      busy = false;
    }
  };

  timer = window.setInterval(() => void tick(), LIVE_TICK_MS);
  const onPlaying = () => {
    void ctx?.resume();
    void tick();
  };
  video.addEventListener("playing", onPlaying);
  void tick();

  return {
    points: () => acc.slice(),
    stats: () => ({ n: acc.length, silentTicks, tap, lastRms, lastZcr }),
    dispose() {
      disposed = true;
      window.clearInterval(timer);
      video.removeEventListener("playing", onPlaying);
      try {
        void ctx?.close();
      } catch {
        /* ignore */
      }
      ctx = null;
      analyser = null;
      stream = null;
    },
  };
}
