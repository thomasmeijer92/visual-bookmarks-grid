(function registerCatalogBrowserLoader(root, factory) {
  const contract = root?.CatalogUrlContract || (typeof require === "function" ? require("./url-contract") : null);
  const loader = factory(contract);
  if (typeof module !== "undefined" && module.exports) module.exports = loader;
  if (root) root.CatalogBrowserLoader = loader;
}(typeof globalThis === "undefined" ? undefined : globalThis, function createCatalogBrowserLoader(contract) {
  "use strict";

  const nativeString = (value) => typeof value === "string" ? value : "";

  function selectedWebClipSource(clip) {
    if (!contract) return "";
    const canonical = contract.canonicalizeAbsoluteUrl(clip?.canonicalUrl || "");
    if (canonical.ok) return canonical.display;
    const raw = contract.canonicalizeAbsoluteUrl(clip?.sourceUrl || "");
    return raw.ok ? raw.display : "";
  }

  function bookmarkRuntimeHints(bookmark) {
    const source = contract?.canonicalizeAbsoluteUrl(bookmark?.url || "");
    return {
      sourceType: "bookmark",
      sourceRecordId: nativeString(bookmark?.id || bookmark?.tweetId),
      resolverSourceUrl: source?.ok ? source.display : "",
    };
  }

  function webClipRuntimeHints(clip) {
    return {
      sourceType: "web-clip",
      sourceRecordId: nativeString(clip?.id),
      resolverSourceUrl: selectedWebClipSource(clip),
    };
  }

  function resolverSelectorForRuntime(bookmark, clientKey) {
    const media = bookmark?.images?.[0];
    const sourceType = bookmark?.sourceType;
    const sourceUrl = bookmark?.resolverSourceUrl || "";
    const primaryMediaUrl = media?.url || "";
    if (!contract || !["bookmark", "web-clip"].includes(sourceType) || !sourceUrl || !primaryMediaUrl) return null;
    if (!contract.canonicalizeAbsoluteUrl(sourceUrl).ok || !contract.canonicalizeMediaUrl(primaryMediaUrl).ok) return null;
    const selector = { clientKey, sourceType, sourceUrl, primaryMediaUrl };
    const sourceRecordId = nativeString(bookmark?.sourceRecordId);
    const primaryMediaId = nativeString(media?.id || media?.mediaId);
    if (sourceRecordId) selector.sourceRecordId = sourceRecordId;
    if (primaryMediaId) selector.primaryMediaId = primaryMediaId;
    return selector;
  }

  return { selectedWebClipSource, bookmarkRuntimeHints, webClipRuntimeHints, resolverSelectorForRuntime };
}));
