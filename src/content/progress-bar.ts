import type { SkipSegment } from "../shared/segment-cache";
import { ANALYZE_TIMEOUTS } from "../shared/analyze-state";

const SEG_CLASS = "bili-jump-preview-seg";
/** 绿色标段；画在进度条上方，不盖住轨道。 */
const SEG_COLOR = "rgba(34, 197, 94, 0.92)";

let paintRetryTimer = 0;
let pendingPaint: { segment: SkipSegment; duration: number } | null = null;

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
  ].join(";");
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
  document.querySelectorAll(`.${SEG_CLASS}`).forEach((el) => el.remove());
}
