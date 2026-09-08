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

function absUrl(u: string): string {
  if (u.startsWith("//")) return `https:${u}`;
  return u;
}

async function resolveCid(bvid: string, page: number): Promise<number | null> {
  const url = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
  const res = await fetch(url, { headers: API_HEADERS, credentials: "omit" });
  if (!res.ok) return null;
  const json = (await res.json()) as { code?: number; data?: { page: number; cid: number }[] };
  if (json.code !== 0 || !Array.isArray(json.data)) return null;
  const hit = json.data.find((p) => p.page === page) ?? json.data[page - 1];
  return hit?.cid ?? null;
}

async function loadVideoshot(bvid: string, page: number) {
  const cid = await resolveCid(bvid, page);
  if (cid == null) return null;
  const qs = new URLSearchParams({
    bvid,
    cid: String(cid),
    index: "1",
  });
  const res = await fetch(`https://api.bilibili.com/x/player/videoshot?${qs}`, {
    headers: API_HEADERS,
    credentials: "omit",
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    code?: number;
    data?: {
      img_x_len: number;
      img_y_len: number;
      img_x_size: number;
      img_y_size: number;
      image?: string[];
      index?: number[];
    };
  };
  if (json.code !== 0 || !json.data?.image?.length) return null;
  const d = json.data;
  const images = d.image;
  if (!images?.length) return null;
  const sheets: ArrayBuffer[] = [];
  for (const img of images) {
    const imgRes = await fetch(absUrl(img), { headers: API_HEADERS, credentials: "omit" });
    if (!imgRes.ok) continue;
    sheets.push(await imgRes.arrayBuffer());
  }
  if (!sheets.length) return null;
  return {
    img_x_len: d.img_x_len,
    img_y_len: d.img_y_len,
    img_x_size: d.img_x_size,
    img_y_size: d.img_y_size,
    index: Array.isArray(d.index) ? d.index : [],
    sheets,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "loadVideoshot") return false;
  const bvid = String(msg.bvid ?? "");
  const page = Number(msg.page) || 1;
  void loadVideoshot(bvid, page)
    .then((data) => sendResponse({ ok: Boolean(data), data }))
    .catch(() => sendResponse({ ok: false, data: null }));
  return true;
});
