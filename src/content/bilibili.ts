import { ANALYZE_TIMEOUTS, withTimeout, type AnalyzeStage } from "../shared/analyze-state";
import { createLiveAudioCollector, type LiveAudioCollector } from "../shared/audio-sampler";
import { waitUntilSafeToAnalyze } from "../shared/playback-ready";
import { detectJoint, type JointDetectResult } from "../shared/detect-joint";
import {
  loadSegment,
  parseBilibiliPage,
  saveSegment,
  segmentKey,
  type SkipSegment,
} from "../shared/segment-cache";
import { DETECT_DEFAULTS, loadSettings, onSettingsChanged, type JumpSettings } from "../shared/storage";
import { featuresFromVideoshot, fetchVideoshotWithIndex, type TimedFeature } from "../shared/videoshot";
import { clearProgressSegment, renderProgressSegment } from "./progress-bar";

/**
 * 三权分立：
 * - paint：有画面的 MED / provisional HIGH / HIGH / cache
 * - autoSkip：强画面 MED、provisional HIGH、HIGH、cache
 * - persist：仅带音频确认的 HIGH（或 cache 读盘）
 *
 * 纯音频 MED 不画不跳（易标在播放头）。
 */

let settings: JumpSettings = { enabled: true };
let attachedVideo: HTMLVideoElement | null = null;
let live: LiveAudioCollector | null = null;
let analyzeAbort: AbortController | null = null;

let stage: AnalyzeStage = "idle";
let stageKey = "";
let runStartedAt = 0;
let running = false;
/** 单调递增：换跑/换 P 时作废旧 await */
let runGen = 0;

let sessionDone = false;
let pending: {
  key: string;
  duration: number;
  series: TimedFeature[];
  coverageEnd: number;
  keyframeTimes: number[];
  centers: number[];
  since: number;
} | null = null;

let activeSegment: SkipSegment | null = null;
let skipArmed = false;
let skipDisarmed = false;
let userSeeking = false;
let skipInFlight = false;
let skippedForKey = "";
let lastPlayhead = 0;
let audioConfirming = false;
let lastLiveJoint = 0;
/** 仅「成功解出 ≥12 帧」的拉图次数；abort/失败不计入 */
const visualSuccessCounts = new Map<string, number>();

function findVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>(
      "#bilibili-player video, .bpx-player-video-wrap video, .bpx-player-container video",
    ) ?? null
  );
}

function pageKey(duration: number): string | null {
  const page = parseBilibiliPage();
  if (!page) return null;
  return segmentKey(page.bvid, page.page, duration);
}

function setStage(next: AnalyzeStage, extra?: Record<string, unknown>) {
  stage = next;
  try {
    void chrome.storage.local.set({
      biliJumpLastDetect: {
        stage: next,
        key: stageKey || null,
        at: Date.now(),
        href: location.href,
        ...extra,
      },
    });
  } catch {
    /* ignore */
  }
}

function stopLive() {
  live?.dispose();
  live = null;
}

function ensureLive(video: HTMLVideoElement) {
  if (live) return;
  live = createLiveAudioCollector(video, () => {
    void confirmWithAudio(video);
  });
}

/** 检测算法输出不变；落条/跳过时给人留缓冲反应时间。 */
const SKIP_REACTION_BUFFER_SEC = 2;

function trustedSkipFromDetect(detectStart: number, duration: number): SkipSegment {
  const s = Math.min(
    Math.max(0, detectStart + SKIP_REACTION_BUFFER_SEC),
    Math.max(0, duration - 0.05),
  );
  return { s, e: duration };
}

function paintSegment(segment: SkipSegment, duration: number) {
  activeSegment = segment;
  renderProgressSegment(segment, duration);
}

function clearSessionPaint() {
  activeSegment = null;
  skipArmed = false;
  clearProgressSegment();
}

function commitSkip(
  segment: SkipSegment,
  duration: number,
  video: HTMLVideoElement,
  persistKey: string | null,
) {
  skipArmed = true;
  skipDisarmed = false;
  paintSegment(segment, duration);
  if (persistKey) void saveSegment(persistKey, segment);

  const now = video.currentTime;
  if (now < segment.s - 0.2) return;
  if (userSeeking || now > segment.s + 120) {
    skipDisarmed = true;
    return;
  }
  const key = pageKey(duration) ?? "";
  if (skippedForKey === key) return;
  skippedForKey = key;
  skipInFlight = true;
  try {
    video.currentTime = Math.min(duration - 0.05, Math.max(segment.e - 0.05, segment.s));
  } catch {
    skipInFlight = false;
  }
}

/** 有画面的提示段：标条；可选武装自动跳（不落盘） */
function paintVisualHint(segment: SkipSegment, duration: number, video: HTMLVideoElement, armSkip: boolean) {
  paintSegment(segment, duration);
  if (armSkip) {
    skipArmed = true;
    skipDisarmed = video.currentTime >= segment.s - 0.2;
  }
}

function expirePendingIfNeeded() {
  if (!pending) return;
  if (Date.now() - pending.since < ANALYZE_TIMEOUTS.pendingExpireMs) return;
  if (pending.series.length >= 12) {
    pending.since = Date.now();
    return;
  }
  pending = null;
  if (stage === "audio-pending" || stage === "abstain") setStage("idle");
}

async function confirmWithAudio(video: HTMLVideoElement) {
  if (!pending || !settings.enabled || audioConfirming || sessionDone) return;
  if (pending.series.length < 12) return;
  const points = live?.points() ?? [];
  if (points.length < 2) return;
  const near = pending.centers.some((c) => Math.abs(video.currentTime - c) < 90);
  const gap = near ? 3000 : 8000;
  if (Date.now() - lastLiveJoint < gap) return;
  lastLiveJoint = Date.now();
  audioConfirming = true;
  try {
    const result = detectJoint({
      duration: pending.duration,
      coverageEnd: pending.coverageEnd,
      series: pending.series,
      keyframeTimes: pending.keyframeTimes,
      audio: { n: Math.floor(pending.duration), points },
    });
    applyJointResult(pending.key, result, pending.duration, video, true);
  } finally {
    audioConfirming = false;
  }
}

function applyJointResult(
  key: string,
  result: JointDetectResult,
  duration: number,
  video: HTMLVideoElement,
  fromAudio: boolean,
) {
  const hasVisual = (pending?.series.length ?? 0) >= 12;

  if (result.level === "HIGH" && result.fillerStart != null) {
    const seg = trustedSkipFromDetect(result.fillerStart, duration);
    if (!fromAudio) {
      setStage("med", {
        t: seg.s,
        detectT: result.fillerStart,
        reason: result.reason,
        provisionalHigh: true,
      });
      paintVisualHint(seg, duration, video, true);
      return;
    }
    sessionDone = true;
    pending = null;
    stopLive();
    setStage("high", {
      t: seg.s,
      detectT: result.fillerStart,
      reason: result.reason,
      fromAudio: true,
    });
    commitSkip(seg, duration, video, key);
    return;
  }

  if (result.level === "MED" && result.fillerStart != null) {
    if (!hasVisual) {
      setStage("audio-pending", {
        why: "audio-med-no-visual",
        t: result.fillerStart,
        reason: result.reason,
      });
      return;
    }
    const seg = trustedSkipFromDetect(result.fillerStart, duration);
    setStage("med", {
      t: seg.s,
      detectT: result.fillerStart,
      reason: result.reason,
      fromAudio,
    });
    paintVisualHint(seg, duration, video, true);
    return;
  }

  if (activeSegment && (stage === "med" || skipArmed)) {
    setStage("med", {
      holding: true,
      t: activeSegment.s,
      lastLevel: result.level,
      reason: result.reason,
    });
    renderProgressSegment(activeSegment, duration);
    return;
  }
  setStage("audio-pending", {
    reason: result.reason,
    level: result.level,
    fromAudio,
  });
}

async function runDetect(video: HTMLVideoElement) {
  if (!settings.enabled) return;
  if (!Number.isFinite(video.duration) || video.duration < DETECT_DEFAULTS.minVideoSeconds) {
    setStage("fail", { why: "too-short", duration: video.duration });
    return;
  }

  const key = pageKey(video.duration);
  if (!key) {
    setStage("fail", { why: "no-bvid" });
    return;
  }

  expirePendingIfNeeded();

  if (sessionDone && stageKey === key) {
    if (activeSegment) renderProgressSegment(activeSegment, video.duration);
    return;
  }

  // 已有画面结果：只 reconcile 画条 + 听声音，禁止再开一轮拉图
  if (pending?.key === key && pending.series.length >= 12) {
    ensureLive(video);
    void confirmWithAudio(video);
    if (activeSegment) renderProgressSegment(activeSegment, video.duration);
    return;
  }

  if (running) {
    if (Date.now() - runStartedAt > ANALYZE_TIMEOUTS.runWatchdogMs) {
      analyzeAbort?.abort();
      running = false;
      setStage("fail", { why: "watchdog" });
    } else {
      if (activeSegment) renderProgressSegment(activeSegment, video.duration);
      return;
    }
  }

  // 成功 visual 两次仍无 HIGH：停拉图，保留已有标条
  if ((visualSuccessCounts.get(key) ?? 0) >= 2 && !sessionDone) {
    ensureLive(video);
    if (pending?.series.length && pending.series.length >= 12) void confirmWithAudio(video);
    if (activeSegment) renderProgressSegment(activeSegment, video.duration);
    setStage(activeSegment ? "med" : "audio-pending", { why: "visual-cap" });
    return;
  }

  const gen = ++runGen;
  running = true;
  runStartedAt = Date.now();
  stageKey = key;
  analyzeAbort = new AbortController();
  const { signal } = analyzeAbort;

  const alive = () => gen === runGen && !signal.aborted;

  try {
    const cached = await loadSegment(key);
    if (!alive()) return;
    if (cached) {
      sessionDone = true;
      pending = null;
      setStage("cache", { t: cached.s });
      commitSkip(cached, video.duration, video, null);
      return;
    }

    setStage("ready", { t: video.currentTime });
    const ready = await waitUntilSafeToAnalyze(video, {
      signal,
      timeoutMs: ANALYZE_TIMEOUTS.readyMs,
    });
    if (!alive() || !settings.enabled) {
      if (gen === runGen) setStage("fail", { why: "ready", ready, aborted: signal.aborted });
      return;
    }
    if (!ready) {
      setStage("fail", { why: "ready", ready: false });
      return;
    }

    ensureLive(video);

    const page = parseBilibiliPage();
    if (!page) {
      setStage("fail", { why: "no-bvid" });
      return;
    }

    setStage("fetch");
    const shot = await withTimeout(
      fetchVideoshotWithIndex(page.bvid, page.page, video.duration),
      ANALYZE_TIMEOUTS.fetchMs,
      "videoshot",
    ).catch(() => null);
    if (!alive()) {
      if (gen === runGen) setStage("fail", { why: "aborted-fetch" });
      return;
    }

    if (!shot) {
      pending = {
        key,
        duration: video.duration,
        series: [],
        coverageEnd: video.duration,
        keyframeTimes: [],
        centers: [],
        since: Date.now(),
      };
      setStage("audio-pending", { why: "no-videoshot" });
      return;
    }

    setStage("decode");
    const series = await withTimeout(
      featuresFromVideoshot(shot, video.duration),
      ANALYZE_TIMEOUTS.analyzeMs,
      "decode",
    ).catch(() => [] as TimedFeature[]);
    if (!alive()) {
      if (gen === runGen) setStage("fail", { why: "aborted-decode" });
      return;
    }

    const keyframeTimes = shot.index.map(Number).filter((t) => Number.isFinite(t));
    if (series.length < 12) {
      pending = {
        key,
        duration: video.duration,
        series: [],
        coverageEnd: video.duration,
        keyframeTimes,
        centers: [],
        since: Date.now(),
      };
      setStage("audio-pending", {
        why: "few-frames",
        n: series.length,
        bytes: shot.sheets.map((s) => s.byteLength),
      });
      return;
    }

    // 只有成功 visual 才计数
    visualSuccessCounts.set(key, (visualSuccessCounts.get(key) ?? 0) + 1);

    setStage("visual", { n: series.length });
    const coverageEnd = series[series.length - 1]!.t;
    const visual = detectJoint({
      duration: video.duration,
      coverageEnd,
      series,
      keyframeTimes,
    });

    pending = {
      key,
      duration: video.duration,
      series,
      coverageEnd,
      keyframeTimes,
      centers: visual.probeCenters,
      since: Date.now(),
    };

    applyJointResult(key, visual, video.duration, video, false);
    if (!sessionDone) void confirmWithAudio(video);
  } catch (e) {
    if (gen === runGen) {
      setStage("fail", { why: "exception", err: String(e) });
    }
  } finally {
    if (gen === runGen) running = false;
  }
}

function onSeeking() {
  if (skipInFlight) return;
  userSeeking = true;
}

function onSeeked(ev: Event) {
  const video = ev.target as HTMLVideoElement;
  lastPlayhead = video.currentTime;
  if (skipInFlight) {
    skipInFlight = false;
    userSeeking = false;
    return;
  }
  userSeeking = false;
  if (!activeSegment || !skipArmed) return;
  skipDisarmed = video.currentTime >= activeSegment.s - 0.2;
}

function onTimeUpdate(ev: Event) {
  if (!settings.enabled || !activeSegment || !skipArmed) return;
  const video = ev.target as HTMLVideoElement;
  const now = video.currentTime;
  const prev = lastPlayhead;
  lastPlayhead = now;

  // 分析中也允许跳：否则拉图窗口内错过切点
  if (userSeeking || skipInFlight || skipDisarmed) return;

  const start = activeSegment.s;
  const crossed = prev < start - 0.2 && now >= start - 0.2;
  const playedThrough =
    now - prev > 0 && now - prev <= Math.max(2.2, 0.75 * (video.playbackRate || 1) + 0.5);
  if (!crossed || !playedThrough) return;

  const key = pageKey(video.duration) ?? "";
  if (skippedForKey === key) return;
  skippedForKey = key;
  skipInFlight = true;
  try {
    video.currentTime = Math.min(video.duration - 0.05, Math.max(activeSegment.e - 0.05, start));
  } catch {
    skipInFlight = false;
  }
}

function onPlayingStartLive() {
  if (attachedVideo) ensureLive(attachedVideo);
}

function attach(video: HTMLVideoElement) {
  if (attachedVideo === video) return;
  if (attachedVideo) {
    attachedVideo.removeEventListener("timeupdate", onTimeUpdate);
    attachedVideo.removeEventListener("seeking", onSeeking);
    attachedVideo.removeEventListener("seeked", onSeeked);
    attachedVideo.removeEventListener("playing", onPlayingStartLive);
    stopLive();
  }
  attachedVideo = video;
  lastPlayhead = video.currentTime;
  userSeeking = false;
  skipInFlight = false;
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("seeking", onSeeking);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("playing", onPlayingStartLive);
  if (!video.paused) ensureLive(video);

  const kick = () => {
    if (video.readyState >= 2 && video.duration > 1) void runDetect(video);
  };
  if (video.readyState >= 2) kick();
  else video.addEventListener("loadeddata", kick, { once: true });
  video.addEventListener("loadedmetadata", kick);
}

function resetPageState() {
  runGen += 1;
  analyzeAbort?.abort();
  stopLive();
  running = false;
  runStartedAt = 0;
  sessionDone = false;
  pending = null;
  stageKey = "";
  stage = "idle";
  skippedForKey = "";
  skipDisarmed = false;
  userSeeking = false;
  skipInFlight = false;
  audioConfirming = false;
  lastLiveJoint = 0;
  lastPlayhead = 0;
  clearSessionPaint();
  setStage("idle");
}

function pageIdentity(href: string): string {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/video\/(BV[\w]+)/i);
    const bvid = m?.[1] ?? u.pathname;
    const page = u.searchParams.get("p") || "1";
    return `${bvid}|p${page}`;
  } catch {
    return href;
  }
}

function watchDom() {
  const reconcile = () => {
    const v = findVideo();
    if (v) attach(v);
    if (activeSegment && v && Number.isFinite(v.duration)) {
      renderProgressSegment(activeSegment, v.duration);
    }
  };
  const kickDetect = () => {
    const v = findVideo();
    if (!v || !Number.isFinite(v.duration)) return;
    void runDetect(v);
  };

  reconcile();
  kickDetect();

  let lastPage = pageIdentity(location.href);
  const onNav = () => {
    const page = pageIdentity(location.href);
    if (page === lastPage) return;
    lastPage = page;
    // 换 P 清 visualSuccess，允许新分 P 重新拉图
    visualSuccessCounts.clear();
    resetPageState();
    reconcile();
    kickDetect();
  };

  // Mutation 只做导航检测 + 画条 reconcile，不疯狂 kickDetect
  new MutationObserver(() => {
    onNav();
    if (activeSegment) reconcile();
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.setInterval(() => {
    onNav();
    reconcile();
    kickDetect();
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
    sessionDone = false;
    const v = findVideo();
    if (v) void runDetect(v);
  });
  watchDom();
}

void main();
