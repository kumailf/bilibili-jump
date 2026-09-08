/** 用户可见设置：仅总开关（开启后自动识别并跳过） */

export interface JumpSettings {
  /** 总开关；开则分析 + 进度条标记 + 自动跳过 */
  enabled: boolean;
}

export const DEFAULT_SETTINGS: JumpSettings = {
  enabled: true,
};

/** 算法内部参数（不对用户暴露，保证「只关心开关」） */
export const DETECT_DEFAULTS = {
  minFillerSeconds: 60,
  seekToleranceSeconds: 2,
  minVideoSeconds: 480,
  deltaThreshold: 0.035,
  minConfidence: 0.72,
  /** 实际播放累计秒数后再分析，避开开播抢缓冲 */
  minPlayedSeconds: 12,
  /** 播放器已缓冲的连续时长（秒） */
  minBufferedSeconds: 20,
} as const;

const STORAGE_KEY = "bilibiliJumpSettings";

function area(): chrome.storage.StorageArea {
  return chrome.storage.sync ?? chrome.storage.local;
}

export async function loadSettings(): Promise<JumpSettings> {
  const data = await area().get(STORAGE_KEY);
  const raw = data[STORAGE_KEY] as Partial<JumpSettings> | undefined;
  // 兼容旧版含多余字段的配置
  return {
    enabled: raw?.enabled ?? DEFAULT_SETTINGS.enabled,
  };
}

export async function saveSettings(patch: Partial<JumpSettings>): Promise<JumpSettings> {
  const next = { ...(await loadSettings()), ...patch };
  await area().set({ [STORAGE_KEY]: { enabled: next.enabled } });
  return next;
}

export function onSettingsChanged(cb: (s: JumpSettings) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    _areaName: string,
  ) => {
    if (!(STORAGE_KEY in changes)) return;
    const raw = changes[STORAGE_KEY].newValue as Partial<JumpSettings> | undefined;
    cb({ enabled: raw?.enabled ?? DEFAULT_SETTINGS.enabled });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
