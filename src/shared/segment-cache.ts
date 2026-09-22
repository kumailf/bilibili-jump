/**
 * 仅缓存 HIGH 确认的跳过段 [start, end]（秒），控制体积。
 * MED / 低置信 / 无填充：不落盘。
 */

const STORE_KEY = "biliJumpSegments";
const MAX_ENTRIES = 400;

export interface SkipSegment {
  /** 起点秒 */
  s: number;
  /** 终点秒 */
  e: number;
}

interface SegmentStore {
  /** key -> segment；key = BV|p|duration */
  m: Record<string, SkipSegment>;
}

function storage(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

export function segmentKey(bvid: string, page: number, duration: number): string {
  return `v9|${bvid}|p${page}|d${Math.round(duration)}`;
}

export function parseBilibiliPage(): { bvid: string; page: number } | null {
  const q = new URLSearchParams(location.search);
  const path = location.pathname.match(/\/video\/(BV[\w]+)/i);
  const fromQuery = q.get("bvid") ?? "";
  const bvid = path?.[1] ?? (fromQuery.match(/^BV[\w]+/i)?.[0] ?? null);
  if (!bvid) return null;
  const page = Number(q.get("p") || "1");
  return { bvid, page: Number.isFinite(page) && page > 0 ? page : 1 };
}

async function readStore(): Promise<SegmentStore> {
  const data = await storage().get(STORE_KEY);
  const raw = data[STORE_KEY] as SegmentStore | undefined;
  if (!raw || typeof raw.m !== "object" || raw.m == null) return { m: {} };
  return { m: raw.m };
}

async function writeStore(store: SegmentStore): Promise<void> {
  const keys = Object.keys(store.m);
  if (keys.length > MAX_ENTRIES) {
    // 超出则丢掉任意多余项（无序对象足够；保持体积上限）
    const drop = keys.length - MAX_ENTRIES;
    for (let i = 0; i < drop; i++) delete store.m[keys[i]!];
  }
  await storage().set({ [STORE_KEY]: store });
}

export async function loadSegment(key: string): Promise<SkipSegment | null> {
  const store = await readStore();
  const hit = store.m[key];
  if (!hit || !Number.isFinite(hit.s) || !Number.isFinite(hit.e) || hit.e <= hit.s) return null;
  return hit;
}

export async function saveSegment(key: string, segment: SkipSegment): Promise<void> {
  const store = await readStore();
  store.m[key] = { s: Math.round(segment.s * 10) / 10, e: Math.round(segment.e * 10) / 10 };
  await writeStore(store);
}

export async function removeSegment(key: string): Promise<void> {
  const store = await readStore();
  if (!(key in store.m)) return;
  delete store.m[key];
  await writeStore(store);
}
