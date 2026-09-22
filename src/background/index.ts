import { DEFAULT_SETTINGS, saveSettings } from "../shared/storage";

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await saveSettings(DEFAULT_SETTINGS);
  }
});

const API_HEADERS: Record<string, string> = {
  Referer: "https://www.bilibili.com/",
  Origin: "https://www.bilibili.com",
};

const FETCH_MS = 12_000;

function absUrl(u: string): string {
  if (u.startsWith("//")) return `https:${u}`;
  return u;
}

async function fetchJson(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, { headers: API_HEADERS, credentials: "omit", signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuf(url: string): Promise<ArrayBuffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(absUrl(url), { headers: API_HEADERS, credentials: "omit", signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function resolveCid(bvid: string, page: number): Promise<number | null> {
  const url = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
  const json = (await fetchJson(url)) as { code?: number; data?: { page: number; cid: number }[] } | null;
  if (!json || json.code !== 0 || !Array.isArray(json.data)) return null;
  const hit = json.data.find((p) => p.page === page) ?? json.data[page - 1];
  return hit?.cid ?? null;
}

async function loadVideoshotMeta(bvid: string, page: number) {
  const cid = await resolveCid(bvid, page);
  if (cid == null) return null;

  const qs = new URLSearchParams({ bvid, cid: String(cid), index: "1" });
  let json = (await fetchJson(`https://api.bilibili.com/x/player/videoshot?${qs}`)) as {
    code?: number;
    data?: {
      img_x_len: number;
      img_y_len: number;
      img_x_size: number;
      img_y_size: number;
      image?: string[];
      index?: number[];
    };
  } | null;

  let d = json?.code === 0 ? json.data : null;
  if (d && (!Array.isArray(d.index) || d.index.length < 40)) {
    await new Promise((r) => setTimeout(r, 400));
    json = (await fetchJson(`https://api.bilibili.com/x/player/videoshot?${qs}`)) as typeof json;
    const again = json?.code === 0 ? json.data : null;
    if (again && Array.isArray(again.index) && again.index.length >= (d.index?.length ?? 0)) {
      d = again;
    }
  }
  if (!d?.image?.length) return null;

  return {
    img_x_len: d.img_x_len,
    img_y_len: d.img_y_len,
    img_x_size: d.img_x_size,
    img_y_size: d.img_y_size,
    index: Array.isArray(d.index) ? d.index : [],
    /** 只传 URL，避免 message 传大 ArrayBuffer 被掏空 */
    imageUrls: d.image.map(absUrl),
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "loadVideoshotMeta") {
    const bvid = String(msg.bvid ?? "");
    const page = Number(msg.page) || 1;
    void loadVideoshotMeta(bvid, page)
      .then((data) => sendResponse({ ok: Boolean(data), data }))
      .catch(() => sendResponse({ ok: false, data: null }));
    return true;
  }
  if (msg?.type === "fetchSheet") {
    const url = String(msg.url ?? "");
    void fetchBuf(url)
      .then((buf) => {
        if (!buf || buf.byteLength < 32) {
          sendResponse({ ok: false, b64: null });
          return;
        }
        sendResponse({ ok: true, b64: bufToBase64(buf) });
      })
      .catch(() => sendResponse({ ok: false, b64: null }));
    return true;
  }
  return false;
});
