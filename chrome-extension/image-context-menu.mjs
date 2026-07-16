export const IMAGE_CONTEXT_MENU_ID = "save-image-to-bookmarks-grid";

export const createImageContextMenuHandler = ({
  saveImage,
  saveResult,
  openResult,
  storageArea,
  menuItemId = IMAGE_CONTEXT_MENU_ID,
}) => async (info, tab) => {
  if (info.menuItemId !== menuItemId) return false;

  try {
    const clip = await saveImage(info, tab);
    await saveResult(storageArea, { ok: true, clip, source: "context-menu" });
  } catch (error) {
    await saveResult(storageArea, {
      ok: false,
      error: error.message || "Could not save image.",
      source: "context-menu",
    });
  } finally {
    openResult();
  }
  return true;
};
