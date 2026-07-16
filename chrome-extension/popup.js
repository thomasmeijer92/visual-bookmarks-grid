import {
  LAST_SAVE_KEY,
  getSettings,
  normalizeServerUrl,
  requestClip,
  resolvePreviewAssetUrl,
  saveLastResult,
  saveSettings,
} from "./clipper-client.mjs";

const $ = (id) => document.getElementById(id);

const elements = {
  title: $("view-title"),
  openGrid: $("open-grid"),
  form: $("clip-form"),
  successPanel: $("success-panel"),
  successImage: $("success-image"),
  successTitle: $("success-title"),
  successMeta: $("success-meta"),
  successMessage: $("success-message"),
  saveAnother: $("save-another"),
  pageAvatar: $("page-avatar"),
  pageTitle: $("page-title"),
  pageHost: $("page-host"),
  tags: $("tags-input"),
  note: $("note-input"),
  serverUrl: $("server-url"),
  status: $("status"),
  save: $("save-button"),
};

let activeTab = null;

const hostFromUrl = (value) => {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "Current page";
  }
};

const setStatus = (message, type = "") => {
  elements.status.textContent = message || "";
  elements.status.classList.toggle("error", type === "error");
};

const setSaving = (saving) => {
  elements.save.disabled = saving;
  elements.tags.disabled = saving;
  elements.note.disabled = saving;
  elements.serverUrl.disabled = saving;
};

const getActiveTab = async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
};

const renderCurrentPage = () => {
  const title = activeTab?.title || "Current page";
  const url = activeTab?.url || "";
  const favicon = activeTab?.favIconUrl || "";

  elements.pageTitle.textContent = title;
  elements.pageHost.textContent = hostFromUrl(url);
  elements.pageAvatar.src = favicon || "icon.svg";
};

const clipAssetUrl = (value) => {
  return resolvePreviewAssetUrl(value, elements.serverUrl.value);
};

const renderSuccess = (saveResult) => {
  elements.title.textContent = saveResult?.ok ? "Saved" : "Save failed";
  elements.form.hidden = true;
  elements.successPanel.hidden = false;

  if (!saveResult?.ok) {
    elements.successImage.src = "icon.svg";
    elements.successTitle.textContent = "Could not save item";
    elements.successMeta.textContent = "Start the local server and confirm the Server URL";
    elements.successMessage.textContent = saveResult?.error || "The local server did not accept the clip.";
    return;
  }

  const clip = saveResult.clip || {};
  elements.successImage.src = clipAssetUrl(clip.media?.url || clip.avatar?.url) || "icon.svg";
  elements.successTitle.textContent = clip.title || "Saved item";
  elements.successMeta.textContent = [clip.sourcePlatform, clip.siteName || clip.host].filter(Boolean).join(" - ") || "Visual Grid";
  elements.successMessage.textContent = clip.captureMode === "image"
    ? "The selected image is saved. Any open grid refreshes automatically."
    : "The page is saved. Any open grid refreshes automatically.";
};

const renderForm = () => {
  elements.title.textContent = "Save page";
  elements.successPanel.hidden = true;
  elements.form.hidden = false;
  setStatus("");
};

const savePage = async () => {
  const url = activeTab?.url || "";
  if (!url || !/^https?:\/\//i.test(url)) {
    setStatus("Open a regular website before saving.", "error");
    return;
  }

  const serverUrl = normalizeServerUrl(elements.serverUrl.value);
  setSaving(true);
  setStatus("Fetching page metadata...");

  try {
    await saveSettings(chrome.storage.local, { serverUrl });
    const clip = await requestClip({
      serverUrl,
      clip: {
        url,
        title: activeTab?.title || "",
        tags: elements.tags.value,
        note: elements.note.value,
      },
      fallbackError: "Could not save this page.",
    });

    const saveResult = { ok: true, clip, source: "popup" };
    await saveLastResult(chrome.storage.local, saveResult);
    renderSuccess(saveResult);
  } catch (error) {
    const saveResult = {
      ok: false,
      error: error.message || "Could not save this page.",
      source: "popup",
    };
    await saveLastResult(chrome.storage.local, saveResult);
    setStatus(saveResult.error, "error");
  } finally {
    setSaving(false);
  }
};

const openGrid = () => {
  const serverUrl = normalizeServerUrl(elements.serverUrl.value);
  chrome.tabs.create({ url: serverUrl });
};

const init = async () => {
  const settings = await getSettings(chrome.storage.local);
  elements.serverUrl.value = normalizeServerUrl(settings.serverUrl);
  activeTab = await getActiveTab();
  renderCurrentPage();

  elements.openGrid.addEventListener("click", openGrid);
  elements.saveAnother.addEventListener("click", renderForm);
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void savePage();
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get("result") === "1") {
    const result = await chrome.storage.local.get([LAST_SAVE_KEY]);
    renderSuccess(result[LAST_SAVE_KEY]);
  }
};

void init();
