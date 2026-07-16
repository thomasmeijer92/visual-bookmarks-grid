import {
  saveLastResult,
} from "./clipper-client.mjs";
import { createImageContextMenuHandler } from "./image-context-menu.mjs";
import { saveImageClip } from "./image-save.mjs";

const openResultWindow = () => {
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?result=1"),
    type: "popup",
    width: 392,
    height: 560,
    focused: true,
  });
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-image-to-bookmarks-grid",
    title: "Save image to Visual Grid",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(createImageContextMenuHandler({
  saveImage: saveImageClip,
  saveResult: saveLastResult,
  openResult: openResultWindow,
  storageArea: chrome.storage.local,
}));
