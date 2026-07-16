export const DEFAULT_SERVER_URL = "http://127.0.0.1:3000";
export const LAST_SAVE_KEY = "lastSave";
export const SETTINGS_KEY = "settings";

export const normalizeServerUrl = (value) => {
  const clean = String(value || DEFAULT_SERVER_URL).trim().replace(/\/+$/, "");
  return clean || DEFAULT_SERVER_URL;
};

const isLoopbackServer = (url) => {
  if (!url || !["http:", "https:"].includes(url.protocol)) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
};

export const resolvePreviewAssetUrl = (value, serverUrl) => {
  if (!value) return "";
  try {
    const configuredServer = new URL(normalizeServerUrl(serverUrl));
    if (!isLoopbackServer(configuredServer)) return "";
    const resolved = new URL(value, configuredServer);
    if (
      !["http:", "https:"].includes(resolved.protocol) ||
      resolved.username ||
      resolved.password ||
      resolved.origin !== configuredServer.origin
    ) {
      return "";
    }
    return resolved.href;
  } catch {
    return "";
  }
};

export const getSettings = async (storageArea) => {
  const result = await storageArea.get([SETTINGS_KEY]);
  return result[SETTINGS_KEY] || {};
};

export const saveSettings = (storageArea, settings) =>
  storageArea.set({
    [SETTINGS_KEY]: {
      ...settings,
      serverUrl: normalizeServerUrl(settings?.serverUrl),
    },
  });

export const saveLastResult = (storageArea, payload, now = () => new Date()) =>
  storageArea.set({
    [LAST_SAVE_KEY]: {
      ...payload,
      savedAt: now().toISOString(),
    },
  });

export const requestClip = async ({
  serverUrl,
  clip,
  fallbackError = "Could not save this item.",
  fetchImpl = globalThis.fetch,
}) => {
  const response = await fetchImpl(`${normalizeServerUrl(serverUrl)}/api/clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clip }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok || !result.clip) {
    throw new Error(result.error || fallbackError);
  }
  return result.clip;
};
