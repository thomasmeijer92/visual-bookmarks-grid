import {
  getSettings,
  normalizeServerUrl,
  requestClip,
} from "./clipper-client.mjs";

export const saveImageClip = async (info, tab, { storageArea = globalThis.chrome?.storage?.local } = {}) => {
  if (!storageArea) throw new Error("Extension storage is unavailable.");

  const pageUrl = info.pageUrl || tab?.url || info.srcUrl;
  const imageUrl = info.srcUrl;
  const pageTitle = tab?.title || "Saved image";
  const settings = await getSettings(storageArea);
  const serverUrl = normalizeServerUrl(settings.serverUrl);

  if (!pageUrl || !imageUrl) {
    throw new Error("Could not read the image URL from this page.");
  }

  return requestClip({
    serverUrl,
    clip: {
      url: pageUrl,
      imageUrl,
      title: pageTitle,
      tags: "",
      note: "Saved from the image context menu.",
    },
    fallbackError: "Could not save this image.",
  });
};
