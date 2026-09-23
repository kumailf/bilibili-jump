import type { SkipSegment } from "../shared/segment-cache";
import { ANALYZE_TIMEOUTS } from "../shared/analyze-state";

const SEG_CLASS = "bili-jump-preview-seg";
/** 绿色标段；画在进度条上方，不盖住轨道。 */
const SEG_COLOR = "rgba(34, 197, 94, 0.92)";

const CTRL_WRAP_SELECTORS = [
  ".bpx-player-control-wrap",
  ".bilibili-player-video-control-wrap",
];

let paintRetryTimer = 0;
let pendingPaint: { segment: SkipSegment; duration: number } | null = null;

/** 同步跳过条与控制栏显隐 */
let visibilityObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedProgress: HTMLElement | null = null;
let observedChrome: HTMLElement | null = null;

function clock(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function findProgressParent(): HTMLElement | null {
  const root =
    document.querySelector("#bilibili-player") ??
    document.querySelector(".bpx-player-container") ??
    document;

  const selectors = [
    ".bpx-player-progress-schedule-wrap",
    ".bpx-player-ctrl-progress-schedule",
    ".bpx-player-progress-wrap",
    ".bpx-player-control-progress .bpx-player-progress",
    ".bpx-player-ctrl-progress .bpx-player-progress",
    ".bpx-player-progress",
    ".bilibili-player-video-progress",
  ];

  const seen = new Set<HTMLElement>();
  const candidates: HTMLElement[] = [];
  for (const sel of selectors) {
    root.querySelectorAll(sel).forEach((el) => {
      if (!(el instanceof HTMLElement) || seen.has(el)) return;
      seen.add(el);
      const r = el.getBoundingClientRect();
      // 收起时可能 height 很小，仍保留有宽度的轨道
      if (r.width < 120) return;
      candidates.push(el);
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
  return candidates[0]!;
}

function findControlWrap(from: HTMLElement): HTMLElement | null {
  for (const sel of CTRL_WRAP_SELECTORS) {
    const el = from.closest(sel);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

/**
 * B 站控制栏显隐：常见为容器 `[data-ctrl-hidden]`，
 * 或 `.bpx-player-control-wrap` 的 opacity / 高度收起。
 */
function isControlChromeVisible(progressParent: HTMLElement): boolean {
  const hiddenHost = progressParent.closest("[data-ctrl-hidden]");
  if (hiddenHost?.getAttribute("data-ctrl-hidden") === "true") return false;

  const wrap = findControlWrap(progressParent);
  if (wrap) {
    const cs = getComputedStyle(wrap);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    if (wrap.getBoundingClientRect().height < 8) return false;
  }

  // 轨道被收成 0 高时，overflow:visible 仍会让上方绝对定位标段露出
  if (progressParent.getBoundingClientRect().height < 1) return false;

  return true;
}

function applySegVisibility(bar: HTMLElement, progressParent: HTMLElement) {
  const show = isControlChromeVisible(progressParent);
  bar.style.visibility = show ? "visible" : "hidden";
  bar.style.opacity = show ? "1" : "0";
}

function stopVisibilitySync() {
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  observedProgress = null;
  observedChrome = null;
}

function ensureVisibilitySync(bar: HTMLElement, progressParent: HTMLElement) {
  const wrap = findControlWrap(progressParent);
  const attrHost =
    (progressParent.closest("[data-ctrl-hidden]") as HTMLElement | null) ??
    (progressParent.closest(".bpx-player-container") as HTMLElement | null) ??
    (document.querySelector("#bilibili-player") as HTMLElement | null);

  const sync = () => {
    if (!bar.isConnected || !progressParent.isConnected) {
      stopVisibilitySync();
      return;
    }
    applySegVisibility(bar, progressParent);
  };

  if (observedProgress !== progressParent || observedChrome !== (wrap ?? attrHost)) {
    stopVisibilitySync();
    observedProgress = progressParent;
    observedChrome = wrap ?? attrHost;

    visibilityObserver = new MutationObserver(sync);
    const observeOpts: MutationObserverInit = {
      attributes: true,
      attributeFilter: ["data-ctrl-hidden", "class", "style"],
    };
    if (attrHost) visibilityObserver.observe(attrHost, observeOpts);
    if (wrap && wrap !== attrHost) visibilityObserver.observe(wrap, observeOpts);

    resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(progressParent);
    if (wrap) resizeObserver.observe(wrap);
  }

  sync();
}

function paintOn(parent: HTMLElement, segment: SkipSegment, duration: number) {
  let bar = parent.querySelector(`:scope > .${SEG_CLASS}`) as HTMLElement | null;
  if (!bar) {
    bar = document.createElement("div");
    bar.className = SEG_CLASS;
    bar.setAttribute("data-bili-jump", "filler");
    const cs = getComputedStyle(parent);
    if (cs.position === "static") parent.style.position = "relative";
    parent.appendChild(bar);
  }
  const left = Math.max(0, Math.min(100, (segment.s / duration) * 100));
  const width = Math.max(0.4, Math.min(100 - left, ((segment.e - segment.s) / duration) * 100));
  bar.title = `可跳过 ${clock(segment.s)} – ${clock(segment.e)}`;
  bar.setAttribute("data-start", String(Math.round(segment.s)));
  // 避免父级 overflow:hidden 裁掉上方标段
  if (getComputedStyle(parent).overflow !== "visible") {
    parent.style.overflow = "visible";
  }
  const trackH = Math.max(2, parent.getBoundingClientRect().height || 3);
  const show = isControlChromeVisible(parent);
  bar.style.cssText = [
    "position:absolute",
    "top:auto",
    "bottom:calc(100% + 2px)",
    `height:${Math.round(trackH)}px`,
    `left:${left}%`,
    `width:${width}%`,
    `background:${SEG_COLOR}`,
    "pointer-events:none",
    "z-index:40",
    "border-radius:2px",
    "box-shadow:0 0 0 1px rgba(0,0,0,0.25)",
    `visibility:${show ? "visible" : "hidden"}`,
    `opacity:${show ? "1" : "0"}`,
  ].join(";");
  ensureVisibilitySync(bar, parent);
}

function schedulePaintRetry(segment: SkipSegment, duration: number) {
  pendingPaint = { segment, duration };
  if (paintRetryTimer) return;
  paintRetryTimer = window.setInterval(() => {
    if (!pendingPaint) {
      window.clearInterval(paintRetryTimer);
      paintRetryTimer = 0;
      return;
    }
    const parent = findProgressParent();
    if (!parent) return;
    const { segment: seg, duration: dur } = pendingPaint;
    pendingPaint = null;
    window.clearInterval(paintRetryTimer);
    paintRetryTimer = 0;
    // 清掉挂在错误父节点上的旧条
    document.querySelectorAll(`.${SEG_CLASS}`).forEach((el) => {
      if (el.parentElement !== parent) el.remove();
    });
    paintOn(parent, seg, dur);
  }, ANALYZE_TIMEOUTS.paintRetryMs);
}

/**
 * 权威状态在调用方的 segment；这里负责 reconcile 到 DOM。
 * 找不到父节点时不先清空已有条，并排队重试（避免 clear-miss）。
 */
export function renderProgressSegment(segment: SkipSegment | null, duration: number) {
  if (!segment || !Number.isFinite(duration) || duration <= 0) {
    pendingPaint = null;
    if (paintRetryTimer) {
      window.clearInterval(paintRetryTimer);
      paintRetryTimer = 0;
    }
    clearProgressSegment();
    return;
  }

  const parent = findProgressParent();
  if (!parent) {
    schedulePaintRetry(segment, duration);
    return;
  }

  pendingPaint = null;
  if (paintRetryTimer) {
    window.clearInterval(paintRetryTimer);
    paintRetryTimer = 0;
  }

  document.querySelectorAll(`.${SEG_CLASS}`).forEach((el) => {
    if (el.parentElement !== parent) el.remove();
  });
  paintOn(parent, segment, duration);
}

export function clearProgressSegment() {
  pendingPaint = null;
  if (paintRetryTimer) {
    window.clearInterval(paintRetryTimer);
    paintRetryTimer = 0;
  }
  stopVisibilitySync();
  document.querySelectorAll(`.${SEG_CLASS}`).forEach((el) => el.remove());
}
