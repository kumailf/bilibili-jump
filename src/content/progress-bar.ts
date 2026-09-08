import type { SkipSegment } from "../shared/segment-cache";

const SEG_CLASS = "bili-jump-preview-seg";
/** 与空降助手类别条类似的高对比色（片尾填充） */
const SEG_COLOR = "rgba(0, 212, 200, 0.92)";

function findProgressParents(): HTMLElement[] {
  const selectors = [
    ".bpx-player-progress-schedule-wrap",
    ".bpx-player-progress",
    ".bilibili-player-video-progress",
  ];
  const out: HTMLElement[] = [];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach((el) => {
      if (el instanceof HTMLElement) out.push(el);
    });
  }
  return out;
}

function paintOn(parent: HTMLElement, segment: SkipSegment | null, duration: number) {
  let bar = parent.querySelector(`:scope > .${SEG_CLASS}`) as HTMLElement | null;
  if (!segment || !Number.isFinite(duration) || duration <= 0) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = SEG_CLASS;
    bar.setAttribute("data-bili-jump", "filler");
    const cs = getComputedStyle(parent);
    if (cs.position === "static") parent.style.position = "relative";
    parent.appendChild(bar);
  }
  const left = Math.max(0, Math.min(100, (segment.s / duration) * 100));
  const width = Math.max(0, Math.min(100 - left, ((segment.e - segment.s) / duration) * 100));
  bar.style.cssText = [
    "position:absolute",
    "top:0",
    "bottom:0",
    `left:${left}%`,
    `width:${width}%`,
    `background:${SEG_COLOR}`,
    "pointer-events:none",
    "z-index:3",
    "border-radius:1px",
    "opacity:0.95",
  ].join(";");
}

/** 在进度条上绘制跳过段；segment 为 null 时清除 */
export function renderProgressSegment(segment: SkipSegment | null, duration: number) {
  const parents = findProgressParents();
  if (!parents.length) {
    if (!segment) return;
    // 播放器未就绪时稍后再试
    return;
  }
  for (const p of parents) paintOn(p, segment, duration);
}

export function clearProgressSegment() {
  document.querySelectorAll(`.${SEG_CLASS}`).forEach((el) => el.remove());
}
