#!/usr/bin/env python3
"""离线复现多信号片尾填充检测（对齐扩展 detect.ts）。"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

SIZE = 32
H_BINS, S_BINS, V_BINS = 16, 8, 8


def rgb_to_hsv(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    h = 0.0
    if d > 1e-6:
        if mx == r:
            h = ((g - b) / d) % 6
        elif mx == g:
            h = (b - r) / d + 2
        else:
            h = (r - g) / d + 4
        h /= 6
        if h < 0:
            h += 1
    s = 0.0 if mx < 1e-6 else d / mx
    return h, s, mx


def frame_feat(video: Path, t: float):
    data = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-ss",
            f"{t:.3f}",
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-vf",
            f"scale={SIZE}:{SIZE}:flags=area,format=rgba",
            "-f",
            "rawvideo",
            "-",
        ]
    )
    luma = []
    hist = [0.0] * (H_BINS + S_BINS + V_BINS)
    sum_l = 0.0
    pix = SIZE * SIZE
    for y in range(SIZE):
        for x in range(SIZE):
            i = (y * SIZE + x) * 4
            r, g, b = data[i] / 255, data[i + 1] / 255, data[i + 2] / 255
            yl = 0.299 * r + 0.587 * g + 0.114 * b
            luma.append(yl)
            sum_l += yl
            h, s, v = rgb_to_hsv(r, g, b)
            hist[min(H_BINS - 1, int(h * H_BINS))] += 1
            hist[H_BINS + min(S_BINS - 1, int(s * S_BINS))] += 1
            hist[H_BINS + S_BINS + min(V_BINS - 1, int(v * V_BINS))] += 1
    for i in range(H_BINS):
        hist[i] /= pix
    for i in range(S_BINS):
        hist[H_BINS + i] /= pix
    for i in range(V_BINS):
        hist[H_BINS + S_BINS + i] /= pix
    return {"luma": luma, "hist": hist, "mean": sum_l / pix}


def cos(a, b):
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    return 0.0 if na == 0 or nb == 0 else dot / math.sqrt(na * nb)


def hist_int(a, b):
    return min(1.0, sum(min(x, y) for x, y in zip(a, b)) / 3)


def sim(a, b):
    return 0.42 * cos(a["luma"], b["luma"]) + 0.43 * hist_int(a["hist"], b["hist"]) + 0.15 * (
        1 - min(1.0, abs(a["mean"] - b["mean"]) * 2.2)
    )


def avg(parts):
    n = len(parts)
    luma = [0.0] * len(parts[0]["luma"])
    hist = [0.0] * len(parts[0]["hist"])
    mean = 0.0
    for p in parts:
        for i, v in enumerate(p["luma"]):
            luma[i] += v
        for i, v in enumerate(p["hist"]):
            hist[i] += v
        mean += p["mean"]
    return {
        "luma": [v / n for v in luma],
        "hist": [v / n for v in hist],
        "mean": mean / n,
    }


def linspace(a, b, n):
    if n <= 1:
        return [a]
    return [a + (b - a) * i / (n - 1) for i in range(n)]


def duration_of(video: Path) -> float:
    return float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(video),
            ],
            text=True,
        ).strip()
    )


def soft(v, mid, scale):
    return 1 / (1 + math.exp(-(v - mid) * scale))


def detect(video: Path, min_filler=60.0, tol=2.0, delta_thr=0.035, min_conf=0.72):
    duration = duration_of(video)
    body_range = (0.08, 0.4)
    tail_sec = 100
    coarse_step = max(12.0, min(25.0, duration / 120))

    times = sorted(
        set(
            [round(t * 2) / 2 for t in linspace(duration * body_range[0], duration * body_range[1], 8)]
            + [
                round(t * 2) / 2
                for t in linspace(duration * 0.45, duration - 1.5, max(16, int(duration * 0.55 / coarse_step)))
            ]
        )
    )
    print(f"sampling {len(times)} frames…", flush=True)
    coarse = []
    for i, t in enumerate(times):
        coarse.append({"t": t, "fp": frame_feat(video, t)})
        if i % 10 == 0:
            print(f"  {i}/{len(times)}", flush=True)

    body_pts = [x for x in coarse if duration * body_range[0] <= x["t"] <= duration * body_range[1]]
    tail_pts = [x for x in coarse if x["t"] >= duration - tail_sec]
    body = avg([x["fp"] for x in body_pts])
    tail = avg([x["fp"] for x in tail_pts])

    def delta(fp):
        return sim(fp, tail) - sim(fp, body)

    body_md = sum(delta(x["fp"]) for x in body_pts) / len(body_pts)
    tail_md = sum(delta(x["fp"]) for x in tail_pts) / len(tail_pts)
    shift = tail_md - body_md
    sep = 1 - sim(body, tail)

    series = [{"t": x["t"], "d": delta(x["fp"])} for x in coarse if x["t"] >= duration * 0.35]
    need = max(3, math.ceil(45 / coarse_step))
    coarse_start = None
    for i in range(0, len(series) - need + 1):
        win = series[i : i + need]
        if all(p["d"] >= delta_thr for p in win) and sum(p["d"] for p in win) / need >= delta_thr + 0.01:
            coarse_start = win[0]["t"]
            break

    if coarse_start is None or tail_md < delta_thr or shift < delta_thr * 1.2 or sep < 0.08:
        return {
            "found": False,
            "reason": "gate fail",
            "bodyMeanDelta": body_md,
            "tailMeanDelta": tail_md,
            "shift": shift,
            "sep": sep,
            "coarseStart": coarse_start,
        }

    lo = max(duration * 0.3, coarse_start - coarse_step * 2)
    hi = min(duration - min_filler, coarse_start + coarse_step)

    def mean_delta_at(t):
        pts = [frame_feat(video, x) for x in (t, t + 1.2, t + 2.5)]
        return sum(delta(p) for p in pts) / len(pts)

    while hi - lo > tol:
        m = (lo + hi) / 2
        if mean_delta_at(m) >= delta_thr:
            hi = m
        else:
            lo = m
    start = hi

    sustain_times = linspace(start + 5, duration - 2, 6)
    sustain = [frame_feat(video, t) for t in sustain_times]
    sustained = sum(1 for p in sustain if delta(p) >= delta_thr) / len(sustain)

    # cut around boundary
    around_t = [start - 3, start - 1.2, start + 0.4, start + 2.5]
    around = [frame_feat(video, t) for t in around_t]
    cut = 0.0
    for i in range(len(around) - 1):
        cut = max(cut, 1 - sim(around[i], around[i + 1]))

    signals = {
        "domainShift": soft(shift, 0.06, 40),
        "bodyTailSep": soft(sep, 0.12, 25),
        "cutStrength": soft(cut, 0.18, 18),
        "sustained": sustained,
    }
    conf = (
        0.28 * signals["domainShift"]
        + 0.14 * 0.8
        + 0.18 * signals["bodyTailSep"]
        + 0.12 * signals["cutStrength"]
        + 0.28 * signals["sustained"]
    )
    found = conf >= min_conf and sustained >= 0.66 and duration - start >= min_filler
    return {
        "found": found,
        "fillerStart": start,
        "fillerLen": duration - start,
        "confidence": conf,
        "signals": signals,
        "bodyMeanDelta": body_md,
        "tailMeanDelta": tail_md,
        "coarseStart": coarse_start,
        "sustained": sustained,
        "cut": cut,
        "duration": duration,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--json-out", type=Path)
    args = ap.parse_args()
    result = detect(args.video)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.json_out:
        args.json_out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
