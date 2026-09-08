import { detectFillerStart } from "../shared/detect";
import { waitUntilSafeToAnalyze } from "../shared/playback-ready";
import {
  loadSegment,
  parseBilibiliPage,
  saveSegment,
  segmentKey,
  type SkipSegment,
} from "../shared/segment-cache";
import { DETECT_DEFAULTS, loadSettings, onSettingsChanged, type JumpSettings } from "../shared/storage";
import { createSeekSampler, type FrameSampler } from "../shared/video-sampler";
import {
  createSeriesSampler,
  featuresFromVideoshot,
  fetchVideoshotFromBackground,
} from "../shared/videoshot";
import { clearProgressSegment, renderProgressSegment } from "./progress-bar";

let settings: JumpSettings = { enabled: true };
let running = false;
const sessionDone = new Set<string>();
let activeSegment: SkipSegment | null = null;
let attachedVideo: HTMLVideoElement | null = null;
let skippedForKey = "";
let analyzeAbort: AbortController | null = null;

function findVideo(): HTMLVideoElement | null {
  return document.querySelector("#bilibili-player video, .bpx-player-video-wrap video, video");
}

function pageKey(duration: number): string | null {
  const page = parseBilibiliPage();
  if (!page) return null;
  return segmentKey(page.bvid, page.page, duration);
}

function applySegment(segment: SkipSegment | null, duration: number) {
  activeSegment = segment;
  if (segment && settings.enabled) renderProgressSegment(segment, duration);
  else clearProgressSegment();
}

function waitUntilPaused(video: HTMLVideoElement, signal: AbortSignal): Promise<boolean> {
  if (video.paused) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      video.removeEventListener("pause", onPause);
      signal.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onPause = () => done(true);
    const onAbort = () => done(false);
    video.addEventListener("pause", onPause);
    signal.addEventListener("abort", onAbort);
  });
}

async function samplerWithoutInterrupting(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<FrameSampler | null> {
  const page = parseBilibiliPage();
  if (page) {
    const shot = await fetchVideoshotFromBackground(page.bvid, page.page);
    if (shot && !signal.aborted) {
      const series = await featuresFromVideoshot(shot, video.duration);
      if (series.length >= 12) return createSeriesSampler(series);
    }
  }
  // 雪碧图不可用时：等用户自己暂停，绝不主动 pause/seek 正在播放的画面
  const paused = await waitUntilPaused(video, signal);
  if (!paused || signal.aborted) return null;
  return createSeekSampler(video);
}

async function runDetect(video: HTMLVideoElement) {
  if (!settings.enabled) return;
  if (!Number.isFinite(video.duration) || video.duration < DETECT_DEFAULTS.minVideoSeconds) return;

  const key = pageKey(video.duration);
  if (!key || running) return;
  if (sessionDone.has(key)) {
    if (activeSegment) renderProgressSegment(activeSegment, video.duration);
    return;
  }

  running = true;
  analyzeAbort?.abort();
  analyzeAbort = new AbortController();
  const { signal } = analyzeAbort;

  try {
    const cached = await loadSegment(key);
    if (cached) {
      sessionDone.add(key);
      applySegment(cached, video.duration);
      return;
    }

    const ready = await waitUntilSafeToAnalyze(video, { signal });
    if (!ready || signal.aborted || !settings.enabled) return;

    const sampler = await samplerWithoutInterrupting(video, signal);
    if (!sampler || signal.aborted) return;

    const result = await detectFillerStart(video.duration, sampler, {
      minFillerSeconds: DETECT_DEFAULTS.minFillerSeconds,
      seekToleranceSeconds: DETECT_DEFAULTS.seekToleranceSeconds,
      deltaThreshold: DETECT_DEFAULTS.deltaThreshold,
      minConfidence: DETECT_DEFAULTS.minConfidence,
    });

    if ("restore" in sampler && typeof (sampler as { restore?: () => Promise<void> }).restore === "function") {
      await (sampler as { restore: () => Promise<void> }).restore();
    }

    if (signal.aborted) return;
    sessionDone.add(key);

    if (!result.found || result.fillerStart == null || result.confidence < DETECT_DEFAULTS.minConfidence) {
      applySegment(null, video.duration);
      return;
    }

    const segment: SkipSegment = {
      s: result.fillerStart,
      e: video.duration,
    };
    await saveSegment(key, segment);
    applySegment(segment, video.duration);
  } catch {
    sessionDone.delete(key);
  } finally {
    running = false;
  }
}

function onTimeUpdate(ev: Event) {
  if (!settings.enabled || !activeSegment || running) return;
  const video = ev.target as HTMLVideoElement;
  const key = pageKey(video.duration) ?? "";
  if (video.currentTime >= activeSegment.s - 0.2) {
    if (skippedForKey === key) return;
    skippedForKey = key;
    try {
      video.currentTime = Math.min(video.duration - 0.05, Math.max(activeSegment.e - 0.05, activeSegment.s));
    } catch {
      /* ignore */
    }
  }
}

function attach(video: HTMLVideoElement) {
  if (attachedVideo === video) return;
  if (attachedVideo) attachedVideo.removeEventListener("timeupdate", onTimeUpdate);
  attachedVideo = video;
  video.addEventListener("timeupdate", onTimeUpdate);

  const kick = () => {
    if (video.readyState >= 2 && video.duration > 1) void runDetect(video);
  };
  if (video.readyState >= 2) kick();
  else video.addEventListener("loadeddata", kick, { once: true });
  video.addEventListener("loadedmetadata", kick);
}

function resetPageState() {
  analyzeAbort?.abort();
  activeSegment = null;
  skippedForKey = "";
  clearProgressSegment();
}

function watchDom() {
  const boot = () => {
    const v = findVideo();
    if (v) attach(v);
    if (activeSegment && v && Number.isFinite(v.duration)) {
      renderProgressSegment(activeSegment, v.duration);
    }
  };
  boot();
  let lastHref = location.href;
  const onNav = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    resetPageState();
    boot();
  };
  new MutationObserver(() => {
    onNav();
    boot();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(() => {
    onNav();
    boot();
  }, 2000);
}

async function main() {
  settings = await loadSettings();
  onSettingsChanged((s) => {
    settings = s;
    if (!s.enabled) {
      resetPageState();
      return;
    }
    const v = findVideo();
    if (v) {
      const key = pageKey(v.duration);
      if (key) sessionDone.delete(key);
      void runDetect(v);
    }
  });
  watchDom();
}

void main();
