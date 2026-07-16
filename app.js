// Bookmark data is loaded from local JSON, with sample data as the public starter fallback.
const PUBLIC_DEMO = globalThis.__VISUAL_GRID_PUBLIC_DEMO__ === true;
let ALL_BOOKMARKS = [];
let MEDIA_CARDS = [];
let MEDIA_INDEX_GENERATED_AT = "";
let MEDIA_CARDS_BY_TWEET = new Map();
let MANUAL_NOTES = {};
let WEB_CLIPS = [];
let BOOKMARKS_WITH_IMAGES = [];
let webClipRefreshInFlight = false;
let webClipRenderPending = false;
let webClipRefreshTimer = null;
let webClipSignature = "";
let activeMetadataFilter = null;
let activeSearch = "";
let activeAuthorKey = "";
let activeAuthorLabel = "";
let activeAuthorAvatar = "";

const CONFIG = {
  GAP: 8,
  easingFactor: 0.1,
  POOL_SIZE: 1200,
  BUFFER: 350, // px buffer outside viewport to pre-render
  TILE_WIDTH_MULTIPLIER: 3,
  MAX_ITEM_WIDTH: 320,
};

const WEB_CLIP_REFRESH_INTERVAL_MS = 12000;

const fetchJsonFromFirstAvailable = async (paths, options = {}) => {
  const errors = [];
  for (const path of paths) {
    try {
      const response = await fetch(path, options);
      if (!response.ok) {
        errors.push(`${path}: ${response.status}`);
        continue;
      }
      return { data: await response.json(), path };
    } catch (error) {
      errors.push(`${path}: ${error.message}`);
    }
  }

  throw new Error(`Could not load JSON from ${paths.join(", ")}. ${errors.join("; ")}`);
};

const state = {
  cameraOffset: { x: 0, y: 0 },
  targetOffset: { x: 0, y: 0 },
  isDragging: false,
  previousMousePosition: { x: 0, y: 0 },
  dragStartPosition: { x: 0, y: 0 },
  hasDragged: false,
  touchStart: null,
  lightboxOpen: false,
  lightboxItem: null,
  lightboxAnimating: false,
  debugEnabled: new URLSearchParams(window.location.search).get("debug") === "1",
};

const debugState = {
  frames: 0,
  renderedItems: 0,
  tileCount: 0,
  poolInUse: 0,
  poolSaturated: false,
  poolNearLimit: false,
  startTileX: 0,
  endTileX: 0,
  startTileY: 0,
  endTileY: 0,
};

const emitSound = (name, detail = {}) => {
  window.dispatchEvent(new CustomEvent("bookmark-grid:sound", {
    detail: { name, ...detail },
  }));
};

const viewport = document.getElementById("viewport");
const grid = document.getElementById("grid");
const overlay = document.getElementById("lightbox-overlay");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");
const lightboxTitle = document.getElementById("lightbox-title");
const lightboxLink = document.getElementById("lightbox-link");
const manualNoteSection = document.getElementById("manual-note-section");
const manualNoteEdit = document.getElementById("manual-note-edit");
const manualNoteText = document.getElementById("manual-note-text");
const manualNoteForm = document.getElementById("manual-note-form");
const manualNoteInput = document.getElementById("manual-note-input");
const manualNoteCancel = document.getElementById("manual-note-cancel");
const manualNoteSave = document.getElementById("manual-note-save");
const manualNoteStatus = document.getElementById("manual-note-status");
const clipAddButton = document.getElementById("clip-add-button");
const clipModal = document.getElementById("clip-modal");
const clipForm = document.getElementById("clip-form");
const clipClose = document.getElementById("clip-close");
const clipCancel = document.getElementById("clip-cancel");
const clipSave = document.getElementById("clip-save");
const clipUrlInput = document.getElementById("clip-url-input");
const clipTagsInput = document.getElementById("clip-tags-input");
const clipNoteInput = document.getElementById("clip-note-input");
const clipStatus = document.getElementById("clip-status");
const clipPreview = document.getElementById("clip-preview");
const clipPreviewImage = document.getElementById("clip-preview-image");
const clipPreviewTitle = document.getElementById("clip-preview-title");
const clipPreviewMeta = document.getElementById("clip-preview-meta");
const boardCreateButton = document.getElementById("board-create-button");
const boardModal = document.getElementById("board-modal");
const boardForm = document.getElementById("board-form");
const boardDialogTitle = document.getElementById("board-dialog-title");
const boardDialogClose = document.getElementById("board-dialog-close");
const boardNameInput = document.getElementById("board-name-input");
const boardBriefInput = document.getElementById("board-brief-input");
const boardSelectionHeading = document.getElementById("board-selection-heading");
const boardSelectionList = document.getElementById("board-selection-list");
const boardUnavailableCount = document.getElementById("board-unavailable-count");
const boardDialogStatus = document.getElementById("board-dialog-status");
const boardCancel = document.getElementById("board-cancel");
const boardSave = document.getElementById("board-save");
const boardHeader = document.getElementById("board-header");
const boardHeaderName = document.getElementById("board-header-name");
const boardHeaderCounts = document.getElementById("board-header-counts");
const boardEditButton = document.getElementById("board-edit-button");
const boardCopyButton = document.getElementById("board-copy-button");
const boardExportButton = document.getElementById("board-export-button");
const boardCloseButton = document.getElementById("board-close-button");
const boardUnavailableRepairs = document.getElementById("board-unavailable-repairs");
const boardUnavailableRepairsSummary = document.getElementById("board-unavailable-repairs-summary");
const boardUnavailableRepairsList = document.getElementById("board-unavailable-repairs-list");
const boardLive = document.getElementById("board-live");
const boardCurationSection = document.getElementById("board-curation-section");
const boardCurationEdit = document.getElementById("board-curation-edit");
const boardCurationText = document.getElementById("board-curation-text");
const boardCurationForm = document.getElementById("board-curation-form");
const boardCurationInput = document.getElementById("board-curation-input");
const boardCurationCancel = document.getElementById("board-curation-cancel");
const boardCurationSave = document.getElementById("board-curation-save");
const boardCurationStatus = document.getElementById("board-curation-status");
const boardMoveEarlier = document.getElementById("board-move-earlier");
const boardMoveLater = document.getElementById("board-move-later");
const boardRemoveItem = document.getElementById("board-remove-item");
let debugHud = null;

const boardState = {
  active: null,
  candidates: [],
  previousFocus: null,
  editMode: false,
  modalBackground: [],
  modalBusy: "",
  modalRequestId: 0,
  filterControls: null,
  curationTrigger: null,
  navigationGeneration: 0,
  repairBusy: false,
};
const BOARD_DIALOG_MAX_ITEMS = 50;

const shouldIgnoreDebugShortcut = (target) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, [contenteditable='true']"));
};

const ensureDebugHud = () => {
  if (debugHud) return debugHud;
  debugHud = document.createElement("div");
  debugHud.id = "debug-hud";
  debugHud.className = "debug-hud";
  document.body.appendChild(debugHud);
  return debugHud;
};

const updateDebugHud = () => {
  if (!state.debugEnabled) {
    if (debugHud) debugHud.classList.remove("visible");
    return;
  }

  const hud = ensureDebugHud();
  debugState.poolInUse = activeMap.size;
  debugState.poolSaturated = debugState.poolInUse >= CONFIG.POOL_SIZE;
  debugState.poolNearLimit = !debugState.poolSaturated && debugState.poolInUse >= Math.floor(CONFIG.POOL_SIZE * 0.85);
  const statusLabel = debugState.poolSaturated
    ? "POOL SATURATED"
    : debugState.poolNearLimit
      ? "POOL NEAR LIMIT"
      : "POOL OK";
  hud.classList.toggle("warning", debugState.poolNearLimit || debugState.poolSaturated);
  hud.innerHTML = [
    `<strong>Grid Debug</strong>`,
    `<span class="debug-status">${statusLabel}</span>`,
    `bookmarks: ${BOOKMARKS_WITH_IMAGES.length}`,
    `layout items: ${layoutItems.length}`,
    `pool: ${debugState.poolInUse}/${CONFIG.POOL_SIZE} active`,
    `tiles: x ${debugState.startTileX}..${debugState.endTileX}, y ${debugState.startTileY}..${debugState.endTileY}`,
    `rendered: ${debugState.renderedItems} items across ${debugState.tileCount} tiles`,
    `camera: ${Math.round(state.cameraOffset.x)}, ${Math.round(state.cameraOffset.y)}`,
    `target: ${Math.round(state.targetOffset.x)}, ${Math.round(state.targetOffset.y)}`,
    `tile size: ${Math.round(totalWidth)} x ${Math.round(maxColHeight)}`,
    `press Shift+D to toggle`,
  ].join("<br>");
  hud.classList.add("visible");
};

// --- Masonry layout data (pure data, no DOM) ---
let layoutItems = []; // flat array: { key, bookmark, x, y, w, h }
let colWidth = 0;
let totalWidth = 0;
let maxColHeight = 0;

const getVisibleCols = (viewportWidth) => {
  let cols = 5;
  if (viewportWidth < 700) cols = 2;
  else if (viewportWidth < 1100) cols = 3;

  while (Math.floor((viewportWidth - CONFIG.GAP) / cols) - CONFIG.GAP > CONFIG.MAX_ITEM_WIDTH) {
    cols += 1;
  }

  return cols;
};

const buildMasonryLayout = () => {
  const vw = window.innerWidth;
  const gap = CONFIG.GAP;
  const visibleCols = getVisibleCols(vw);
  const layoutCols = visibleCols * CONFIG.TILE_WIDTH_MULTIPLIER;

  colWidth = Math.floor((vw - gap) / visibleCols);
  totalWidth = colWidth * layoutCols;

  const colHeights = new Array(layoutCols).fill(0);
  const columns = Array.from({ length: layoutCols }, () => []);

  for (const bm of BOOKMARKS_WITH_IMAGES) {
    let minCol = 0;
    for (let c = 1; c < layoutCols; c++) {
      if (colHeights[c] < colHeights[minCol]) minCol = c;
    }

    const img = bm.images[0];
    const aspect = img.width / img.height;
    const itemW = colWidth - gap;
    const itemH = itemW / aspect;

    const x = minCol * colWidth + gap / 2;
    const y = colHeights[minCol] + gap / 2;

    columns[minCol].push({ bookmark: bm, x, y, w: itemW, h: itemH });
    colHeights[minCol] += itemH + gap;
  }

  maxColHeight = Math.max(...colHeights, window.innerHeight);

  layoutItems = [];
  for (let col = 0; col < layoutCols; col++) {
    for (let row = 0; row < columns[col].length; row++) {
      const item = columns[col][row];
      layoutItems.push({
        key: `${col}-${row}`,
        ...item,
      });
    }
  }
};

// --- DOM Pool ---
const pool = []; // all pool elements
const freePool = []; // available elements
const activeMap = new Map(); // visKey → { poolEl, layoutItem, screenX, screenY }
const elToBookmark = new WeakMap(); // poolEl → bookmark (for click handler)

const getAuthorKey = (bookmark) => {
  const handle = (bookmark?.authorHandle || "").trim().toLowerCase();
  if (handle) return `handle:${handle}`;
  const name = (bookmark?.authorName || "").trim().toLowerCase();
  if (name) return `name:${name}`;
  return "";
};

const getAuthorLabel = (bookmark) =>
  (bookmark?.authorName || "").trim() || (bookmark?.authorHandle || "").trim() || "Unknown";

const getAuthorCount = (authorKey) => {
  if (!authorKey) return 0;
  return ALL_BOOKMARKS.reduce((count, bookmark) => {
    if (!bookmark.images || bookmark.images.length === 0) return count;
    return count + (getAuthorKey(bookmark) === authorKey ? 1 : 0);
  }, 0);
};

const getCardsForBookmark = (bookmark) => MEDIA_CARDS_BY_TWEET.get(bookmark?.id) || [];

const addMediaCardToIndex = (card) => {
  const tweetId = card?.tweet?.id;
  if (!tweetId) return;
  const cards = MEDIA_CARDS_BY_TWEET.get(tweetId) || [];
  cards.push(card);
  MEDIA_CARDS_BY_TWEET.set(tweetId, cards);
};

const rebuildMediaCardIndex = () => {
  MEDIA_CARDS_BY_TWEET = new Map();
  for (const card of MEDIA_CARDS) addMediaCardToIndex(card);
};

const clipRuntimeKey = (clip) => JSON.stringify([
  typeof clip?.id === "string" ? clip.id : "",
  clip?.canonicalUrl || clip?.sourceUrl || "",
  clip?.media?.url || "",
]);

const clipBookmarkId = (clip) => `clip:${clipRuntimeKey(clip)}`;

const clipMediaId = (clip) => `${clipBookmarkId(clip)}-01-photo`;

const clipAuthorName = (clip) =>
  (clip.creator || clip.siteName || clip.host || "Web").trim();

const clipAuthorHandle = (clip) =>
  (clip.host || clip.sourcePlatform || "web").trim();

const runtimeBrowserLoader = () => window.CatalogBrowserLoader || null;

const selectedWebClipSource = (clip) => {
  return runtimeBrowserLoader()?.selectedWebClipSource(clip) || "";
};

const decorateRuntimeBookmark = (bookmark) => {
  const hints = runtimeBrowserLoader()?.bookmarkRuntimeHints(bookmark) || {
    sourceType: "bookmark", sourceRecordId: "", resolverSourceUrl: "",
  };
  return {
    ...bookmark,
    ...hints,
  };
};

const clipToBookmark = (clip) => {
  const media = clip.media || {};
  const sourceUrl = selectedWebClipSource(clip);
  return {
    id: clipBookmarkId(clip),
    text: clip.description || clip.title || clip.canonicalUrl || clip.sourceUrl || "",
    url: sourceUrl,
    postedAt: clip.capturedAt || clip.updatedAt || "",
    authorName: clipAuthorName(clip),
    authorHandle: clipAuthorHandle(clip),
    authorAvatar: clip.avatar?.url || "",
    authorBio: clip.siteName || clip.host || "",
    folders: ["Web Clips"],
    tags: ["Web", clip.sourcePlatform || "Web", ...(clip.tags || [])],
    links: [sourceUrl].filter(Boolean),
    sourcePlatform: clip.sourcePlatform || "Web",
    clipId: clip.id,
    clipRuntimeKey: clipRuntimeKey(clip),
    ...(runtimeBrowserLoader()?.webClipRuntimeHints(clip) || {
      sourceType: "web-clip", sourceRecordId: "", resolverSourceUrl: sourceUrl,
    }),
    images: media.url ? [{
      type: media.type || "photo",
      url: media.url,
      videoUrl: "",
      width: media.width || 1200,
      height: media.height || 900,
    }] : [],
  };
};

const clipToCard = (clip) => {
  const bookmarkId = clipBookmarkId(clip);
  const media = clip.media || {};
  const source = clip.sourcePlatform || "Web";
  const tags = ["Web", source, ...(clip.tags || [])].filter(Boolean);
  return {
    mediaId: clipMediaId(clip),
    collection: "Web Clips",
    title: clip.title || clip.canonicalUrl || "Saved URL",
    creator: clipAuthorName(clip),
    creatorHandle: clipAuthorHandle(clip),
    description: clip.description || clip.note || "",
    source,
    category: "Website",
    style: [],
    color: [],
    interaction: ["None"],
    visible: [clip.description, clip.note].filter(Boolean),
    notVisible: [],
    objects: [],
    scene: `Saved web inspiration from ${clip.siteName || clip.host || source}`,
    visibleText: [clip.title, clip.description, clip.note].filter(Boolean).join(" | "),
    confidence: "captured",
    scanStatus: "web_clipped",
    visionError: null,
    media: {
      type: media.type || "photo",
      url: media.url || "",
      videoUrl: "",
      width: media.width || 1200,
      height: media.height || 900,
    },
    tweet: {
      id: bookmarkId,
      url: clip.canonicalUrl || clip.sourceUrl,
      postedAt: clip.capturedAt || clip.updatedAt || "",
      folders: ["Web Clips"],
    },
    author: {
      handle: clipAuthorHandle(clip),
      name: clipAuthorName(clip),
      avatarUrl: clip.avatar?.url || "",
      bio: clip.siteName || clip.host || "",
      location: "",
      followers: 0,
      verified: false,
    },
    originalTaxonomy: {
      collection: "Web Clips",
      category: "Website",
      style: [],
      color: [],
      interaction: ["None"],
    },
    tagGroups: {
      collection: ["Web Clips"],
      category: ["Website"],
      style: [],
      color: [],
      interaction: ["None"],
      source: [source],
    },
    tagSlugs: tags.map((tag) => String(tag).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")),
    tags,
    clip,
  };
};

const upsertWebClip = (clip, { prepend = false } = {}) => {
  if (!clip || typeof clip !== "object") return;
  const bookmarkId = clipBookmarkId(clip);
  const mediaId = clipMediaId(clip);

  WEB_CLIPS = [clip, ...WEB_CLIPS.filter((entry) => clipRuntimeKey(entry) !== clipRuntimeKey(clip))];
  ALL_BOOKMARKS = ALL_BOOKMARKS.filter((bookmark) => bookmark.id !== bookmarkId);
  MEDIA_CARDS = MEDIA_CARDS.filter((card) => card.mediaId !== mediaId);

  const bookmark = clipToBookmark(clip);
  const card = clipToCard(clip);

  if (prepend) {
    ALL_BOOKMARKS.unshift(bookmark);
    MEDIA_CARDS.unshift(card);
  } else {
    ALL_BOOKMARKS.push(bookmark);
    MEDIA_CARDS.push(card);
  }

  rebuildMediaCardIndex();
};

const webClipListSignature = (clips) =>
  (Array.isArray(clips) ? clips : [])
    .map((clip) => [
      clip?.id || "",
      clip?.updatedAt || "",
      clip?.media?.url || "",
      clip?.avatar?.url || "",
      (Array.isArray(clip?.tags) ? clip.tags : []).join(","),
      clip?.note || "",
    ].join(":"))
    .join("|");

const isWebClipBookmark = (bookmark) =>
  Boolean(bookmark?.clipRuntimeKey) || String(bookmark?.id || "").startsWith("clip:");

const isWebClipCard = (card) =>
  String(card?.mediaId || "").startsWith("clip:");

const syncWebClips = (clips) => {
  const nextClips = Array.isArray(clips) ? clips.filter((clip) => clip && typeof clip === "object") : [];
  const nextKeys = new Set(nextClips.map(clipRuntimeKey));

  ALL_BOOKMARKS = ALL_BOOKMARKS.filter((bookmark) =>
    !isWebClipBookmark(bookmark) || nextKeys.has(bookmark.clipRuntimeKey)
  );
  MEDIA_CARDS = MEDIA_CARDS.filter((card) =>
    !isWebClipCard(card) || nextKeys.has(clipRuntimeKey(card.clip))
  );
  WEB_CLIPS = [];

  for (const clip of [...nextClips].reverse()) {
    upsertWebClip(clip, { prepend: true });
  }

  rebuildMediaCardIndex();
  return nextClips.length;
};

const renderSyncedWebClips = () => {
  if (boardState.active) return;
  BOOKMARKS_WITH_IMAGES = filterBookmarks();
  createDesignTopbar();
  updateAuthorPill();
  updateSearchLiveRegion();
  updateDebugHud();

  if (state.lightboxOpen || state.lightboxAnimating) {
    webClipRenderPending = true;
    return;
  }

  webClipRenderPending = false;
  rebuildGrid(false);
};

const refreshWebClips = async ({ render = true, initial = false, force = false } = {}) => {
  if (PUBLIC_DEMO || window.location.protocol === "file:" || webClipRefreshInFlight) return false;
  webClipRefreshInFlight = true;

  try {
    const clipsRes = await fetch("./api/clips", { cache: "no-store" });
    if (!clipsRes.ok) return false;

    const clipsData = await clipsRes.json();
    const clips = Array.isArray(clipsData.clips) ? clipsData.clips : [];
    const nextSignature = webClipListSignature(clips);
    if (!force && nextSignature === webClipSignature) return false;

    webClipSignature = nextSignature;
    const count = syncWebClips(clips);
    if (initial) console.log(`Loaded ${count} web clips`);

    if (render) {
      renderSyncedWebClips();
    }

    return true;
  } catch (e) {
    if (initial) {
      console.warn("Web clips are unavailable. Start the local server to save URLs.", e);
    } else {
      console.warn("Could not refresh web clips.", e);
    }
    return false;
  } finally {
    webClipRefreshInFlight = false;
  }
};

const setupWebClipRefresh = () => {
  if (PUBLIC_DEMO || window.location.protocol === "file:" || webClipRefreshTimer) return;

  const refreshWhenVisible = () => {
    if (document.hidden) return;
    void refreshWebClips();
  };

  window.addEventListener("focus", refreshWhenVisible);
  document.addEventListener("visibilitychange", refreshWhenVisible);
  webClipRefreshTimer = window.setInterval(refreshWhenVisible, WEB_CLIP_REFRESH_INTERVAL_MS);
};

const asSearchValues = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(asSearchValues);
  if (typeof value === "object") return [];
  return [String(value)];
};

const getTagGroupSearchValues = (card) =>
  Object.values(card?.tagGroups || {}).flatMap(asSearchValues);

const getManualNoteSearchText = (card) => {
  const note = card?.mediaId ? MANUAL_NOTES[card.mediaId] : null;
  return [
    note?.note,
    note?.status,
  ].filter(Boolean).join(" ");
};

const getBookmarkMetadataText = (bookmark) => {
  const cards = getCardsForBookmark(bookmark);
  return [
    ...(bookmark?.links || []),
    ...(bookmark?.folders || []),
    ...(bookmark?.tags || []),
    bookmark?.authorBio,
    ...cards.map((card) => [
      card.title,
      card.description,
      card.creator,
      card.creatorHandle,
      card.source,
      card.collection,
      card.category,
      ...(card.style || []),
      ...(card.color || []),
      ...(card.interaction || []),
      ...(card.tags || []),
      ...(card.tagSlugs || []),
      ...getTagGroupSearchValues(card),
      ...(card.visible || []),
      ...(card.notVisible || []),
      card.visibleText,
      ...(card.objects || []),
      card.scene,
      card.media?.type,
      card.tweet?.url,
      ...(card.tweet?.folders || []),
      card.author?.name,
      card.author?.handle,
      card.author?.bio,
      getManualNoteSearchText(card),
    ].filter(Boolean).join(" ")),
  ].filter(Boolean).join(" ");
};

const getCardMetadataText = (card) => [
  card.title,
  card.description,
  card.collection,
  card.category,
  ...(card.tags || []),
  ...(card.tagSlugs || []),
  ...(card.visible || []),
  card.visibleText,
  ...(card.objects || []),
  card.scene,
].filter(Boolean).join(" ").toLowerCase();

const cardValuesForGroup = (card, group) => {
  const grouped = card?.tagGroups?.[group] || [];
  const direct = {
    collection: [card?.collection, ...(card?.tweet?.folders || [])],
    category: [card?.category],
    style: card?.style || [],
    color: card?.color || [],
    interaction: card?.interaction || [],
    mediaType: [card?.media?.type],
    source: [card?.source],
    scanStatus: [card?.scanStatus],
  }[group] || [];

  return uniqueValues([...grouped, ...direct].filter(Boolean));
};

const uniqueValues = (values) => {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const getDisplayTagsForBookmark = (bookmark) => {
  const cards = getCardsForBookmark(bookmark);
  if (cards.length === 0) return uniqueValues([...(bookmark.tags || []), ...(bookmark.folders || [])]).slice(0, 8);

  const primary = getPrimaryCardForBookmark(bookmark);
  return uniqueValues([
    primary.category,
    ...(primary.style || []).slice(0, 3),
    ...(primary.color || []).slice(0, 2),
    ...(primary.interaction || []).filter((value) => value !== "None").slice(0, 2),
  ]).slice(0, 8);
};

const getPrimaryCardForBookmark = (bookmark) => {
  const cards = getCardsForBookmark(bookmark);
  return cards.find((card) => card.scanStatus === "vision_scanned") || cards[0] || null;
};

const getManualNoteContext = (bookmark) => {
  const card = getPrimaryCardForBookmark(bookmark);
  const media = bookmark?.images?.[0] || card?.media || {};
  const mediaId = card?.mediaId || (bookmark?.id && media.url ? `${bookmark.id}:${media.url}` : "");

  return {
    card,
    mediaId,
    tweetId: bookmark?.id || card?.tweet?.id || "",
    tweetUrl: card?.tweet?.url || bookmark?.url || "",
    mediaUrl: card?.media?.url || media.url || "",
    titleAtEdit: card?.title || bookmark?.text || "",
    creatorAtEdit: card?.creator || bookmark?.authorName || bookmark?.authorHandle || "",
  };
};

const getManualNoteEntry = (bookmark) => {
  const { mediaId } = getManualNoteContext(bookmark);
  return mediaId ? MANUAL_NOTES[mediaId] || null : null;
};

const setManualNoteStatus = (message, type = "") => {
  if (!manualNoteStatus) return;
  manualNoteStatus.textContent = message || "";
  manualNoteStatus.classList.toggle("error", type === "error");
};

const setManualNoteEditLabel = (label) => {
  const labelEl = manualNoteEdit?.querySelector("span");
  if (labelEl) labelEl.textContent = label;
};

const renderManualNote = (bookmark) => {
  if (!manualNoteSection || !manualNoteText || !manualNoteForm || !manualNoteInput) return;
  if (PUBLIC_DEMO) {
    manualNoteSection.hidden = true;
    return;
  }

  const { mediaId } = getManualNoteContext(bookmark);
  if (!mediaId) {
    manualNoteSection.hidden = true;
    return;
  }

  manualNoteSection.hidden = false;
  const note = getManualNoteEntry(bookmark)?.note || "";
  manualNoteText.hidden = false;
  manualNoteForm.hidden = true;
  if (manualNoteEdit) manualNoteEdit.hidden = false;
  manualNoteText.textContent = note || "No manual note yet.";
  manualNoteText.classList.toggle("empty", !note);
  manualNoteInput.value = note;
  setManualNoteEditLabel(note ? "Edit" : "Add");
  setManualNoteStatus("");
};

const openManualNoteEditor = () => {
  const bookmark = state.lightboxItem?.bookmark;
  if (!bookmark || !manualNoteForm || !manualNoteInput || !manualNoteText) return;

  const { mediaId } = getManualNoteContext(bookmark);
  if (!mediaId) return;

  manualNoteInput.value = getManualNoteEntry(bookmark)?.note || "";
  manualNoteText.hidden = true;
  manualNoteForm.hidden = false;
  if (manualNoteEdit) manualNoteEdit.hidden = true;
  setManualNoteStatus("Add a rough note for the local review queue.");
  requestAnimationFrame(() => manualNoteInput.focus());
};

const cancelManualNoteEditor = () => {
  renderManualNote(state.lightboxItem?.bookmark);
};

const setManualNoteSaving = (saving) => {
  if (manualNoteSave) manualNoteSave.disabled = saving;
  if (manualNoteCancel) manualNoteCancel.disabled = saving;
  if (manualNoteEdit) manualNoteEdit.disabled = saving;
};

const saveManualNote = async () => {
  if (PUBLIC_DEMO) return;
  const bookmark = state.lightboxItem?.bookmark;
  if (!bookmark || !manualNoteInput) return;

  const context = getManualNoteContext(bookmark);
  if (!context.mediaId) return;

  if (window.location.protocol === "file:") {
    setManualNoteStatus("Start the local server to save notes.", "error");
    return;
  }

  const noteText = manualNoteInput.value.trim();
  const { card, ...noteContext } = context;
  setManualNoteSaving(true);
  setManualNoteStatus(noteText ? "Saving note..." : "Removing note...");

  try {
    const response = await fetch("./api/manual-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: {
          ...noteContext,
          note: noteText,
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Could not save note.");
    }

    if (result.deleted) {
      delete MANUAL_NOTES[context.mediaId];
    } else if (result.entry) {
      MANUAL_NOTES[context.mediaId] = result.entry;
    }

    renderManualNote(bookmark);
    setManualNoteStatus(noteText ? "Saved to the local review queue." : "Note removed.");
    emitSound("folder-select");
  } catch (error) {
    setManualNoteStatus(error.message || "Could not save note.", "error");
  } finally {
    setManualNoteSaving(false);
  }
};

const categoryLabel = (value) => value === "Website" ? "Web" : value;

const metadataValues = (values, limit = 3) =>
  uniqueValues((values || []).filter((value) => value && value !== "None")).slice(0, limit);

const setMetadataRow = (id, values) => {
  const valueEl = document.getElementById(id);
  if (!valueEl) return;
  const rowEl = valueEl.closest(".lightbox-meta-row");
  const cleanValues = metadataValues(Array.isArray(values) ? values : [values], 4);
  if (cleanValues.length === 0) {
    rowEl.hidden = true;
    valueEl.innerHTML = "";
    return;
  }

  rowEl.hidden = false;
  valueEl.innerHTML = "";
  for (const value of cleanValues) {
    const span = document.createElement("span");
    span.textContent = value;
    valueEl.appendChild(span);
  }
};

const getLightboxTargetRect = (vw, vh, aspectRatio) => {
  const isMobile = vw <= 520;
  const sidebarWidth = isMobile ? 0 : Math.min(430, Math.max(320, vw * 0.32));
  const outerGap = isMobile ? 18 : 48;
  const mobileSheetReserve = Math.min(360, Math.max(220, vh * 0.43)) + 36;
  const mainLeft = isMobile ? outerGap : sidebarWidth + outerGap;
  const mainRight = outerGap;
  const mainTop = isMobile ? 24 : 42;
  const mainBottom = isMobile ? mobileSheetReserve : 42;
  const availableW = Math.max(220, vw - mainLeft - mainRight);
  const availableH = Math.max(isMobile ? 96 : 180, vh - mainTop - mainBottom);
  const maxW = availableW * (isMobile ? 0.96 : 0.82);
  const maxH = availableH * (isMobile ? 0.96 : 0.9);

  let targetW;
  let targetH;
  if (maxW / maxH > aspectRatio) {
    targetH = maxH;
    targetW = targetH * aspectRatio;
  } else {
    targetW = maxW;
    targetH = targetW / aspectRatio;
  }

  return {
    x: mainLeft + (availableW - targetW) / 2,
    y: mainTop + (availableH - targetH) / 2,
    width: targetW,
    height: targetH,
  };
};

const bookmarkMatchesSingleFilter = (bookmark, filter) => {
  if (!filter) return true;
  const cards = getCardsForBookmark(bookmark);

  if (cards.length === 0) {
    if (filter.group === "collection") {
      return (bookmark.folders || []).includes(filter.value);
    }
    return false;
  }

  return cards.some((card) => {
    if (filter.group === "text") {
      return getCardMetadataText(card).includes(filter.value.toLowerCase());
    }

    const values = cardValuesForGroup(card, filter.group);
    return values.includes(filter.value);
  });
};

const bookmarkMatchesFilter = (bookmark, filter) => {
  if (!filter) return true;
  if (Array.isArray(filter.matches)) {
    return filter.matches.some((match) => bookmarkMatchesSingleFilter(bookmark, match));
  }
  return bookmarkMatchesSingleFilter(bookmark, filter);
};

const bookmarkMatchesMetadataFilter = (bookmark) => bookmarkMatchesFilter(bookmark, activeMetadataFilter);
const bookmarkCountLabel = (count) => `${count} bookmark${count === 1 ? "" : "s"}`;

const updateSearchLiveRegion = () => {
  const liveEl = document.getElementById("search-live");
  if (!liveEl) return;

  if (boardState.active) {
    const unavailable = boardState.active.resolvedItems.filter((item) => item.status === "unavailable").length;
    liveEl.textContent = unavailable
      ? `${BOOKMARKS_WITH_IMAGES.length} board references available, ${unavailable} unavailable`
      : `${BOOKMARKS_WITH_IMAGES.length} board references available`;
    return;
  }

  if (activeMetadataFilter) {
    liveEl.textContent = `${bookmarkCountLabel(BOOKMARKS_WITH_IMAGES.length)} matching ${activeMetadataFilter.label}`;
    return;
  }

  if (activeAuthorKey) {
    liveEl.textContent = `${bookmarkCountLabel(BOOKMARKS_WITH_IMAGES.length)} by ${activeAuthorLabel}`;
    return;
  }

  if (activeSearch) {
    liveEl.textContent = `${bookmarkCountLabel(BOOKMARKS_WITH_IMAGES.length)} found`;
    return;
  }

  liveEl.textContent = "";
};

const createPool = () => {
  grid.innerHTML = "";
  pool.length = 0;
  freePool.length = 0;
  activeMap.clear();

  for (let i = 0; i < CONFIG.POOL_SIZE; i++) {
    const el = document.createElement("div");
    el.className = "grid-item";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.style.display = "none";
    el.innerHTML = `
      <img src="" alt="" loading="lazy" decoding="async">
      <button class="grid-author-pill" type="button">
        <img class="grid-author-avatar" src="" alt="">
        <span class="grid-author-label"></span>
      </button>
    `;

    const authorPill = el.querySelector(".grid-author-pill");
    authorPill.addEventListener("mousedown", (e) => e.stopPropagation());
    authorPill.addEventListener("click", (e) => {
      e.stopPropagation();
      const bookmark = elToBookmark.get(el);
      if (!bookmark) return;
      setAuthorFilter(bookmark);
    });

    el.addEventListener("keydown", (e) => {
      if (e.target !== el || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      const bookmark = elToBookmark.get(el);
      if (!bookmark) return;
      openLightbox(el, bookmark);
    });

    grid.appendChild(el);
    pool.push(el);
    freePool.push(el);
  }
};

const acquireElement = () => {
  if (freePool.length === 0) return null;
  const el = freePool.pop();
  el.style.display = "";
  return el;
};

const releaseElement = (el) => {
  el.style.display = "none";
  el.style.visibility = "";
  freePool.push(el);
};

// --- Image sizing ---
// Some social image CDNs support ?format=jpg&name=small|medium|large|orig.
// Other media sources are returned unchanged.
const mediaImageUrl = (url, size = "small") => {
  if (!url || !/pbs\.twimg\.com|twimg\.com/i.test(url)) return url || "";
  // Strip any existing params
  const base = url.split("?")[0];
  const ext = base.match(/\.(jpg|jpeg|png)$/i);
  const format = ext ? ext[1].toLowerCase() : "jpg";
  return `${base}?format=${format}&name=${size}`;
};

// --- Virtualized Renderer ---

const renderVisibleItems = () => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const buf = CONFIG.BUFFER;

  // The pool element the lightbox is using, so don't touch it.
  const lightboxEl = state.lightboxItem?.element || null;

  // Use current eased position for rendering transforms
  const camX = state.cameraOffset.x;
  const camY = state.cameraOffset.y;

  // Use the UNION of current + target area for culling,
  // so items at the scroll destination are pre-created
  const targetX = state.targetOffset.x;
  const targetY = state.targetOffset.y;
  const minCullX = Math.min(camX, targetX);
  const maxCullX = Math.max(camX, targetX);
  const minCullY = Math.min(camY, targetY);
  const maxCullY = Math.max(camY, targetY);
  const startTileX = Math.floor((minCullX - buf) / totalWidth);
  const endTileX = Math.floor((maxCullX + vw + buf) / totalWidth);
  const startTileY = Math.floor((minCullY - buf) / maxColHeight);
  const endTileY = Math.floor((maxCullY + vh + buf) / maxColHeight);
  let renderedCount = 0;

  const visibleThisFrame = new Set();

  for (let ty = startTileY; ty <= endTileY; ty++) {
    for (let tx = startTileX; tx <= endTileX; tx++) {
      for (let i = 0; i < layoutItems.length; i++) {
        const item = layoutItems[i];
        const worldX = item.x + tx * totalWidth;
        const worldY = item.y + ty * maxColHeight;
        const sx = worldX - camX;
        const sy = worldY - camY;
        const txs = worldX - targetX;
        const tys = worldY - targetY;

        const visibleAtCam =
          sx + item.w >= -buf && sx <= vw + buf &&
          sy + item.h >= -buf && sy <= vh + buf;
        const visibleAtTarget =
          txs + item.w >= -buf && txs <= vw + buf &&
          tys + item.h >= -buf && tys <= vh + buf;

        if (!visibleAtCam && !visibleAtTarget) {
          continue;
        }

        const visKey = `${item.key}:${tx}:${ty}`;
        visibleThisFrame.add(visKey);
        renderedCount++;

        const existing = activeMap.get(visKey);
        if (existing) {
          if (existing.poolEl !== lightboxEl) {
            existing.poolEl.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
          }
          existing.screenX = sx;
          existing.screenY = sy;
        } else {
          const el = acquireElement();
          if (!el) continue;

          const img = el.querySelector("img");
          const src = mediaImageUrl(item.bookmark.images[0].url, "medium");
          if (img.src !== src) {
            img.src = src;
            img.alt = item.bookmark.text.substring(0, 60);
          }

          const authorPill = el.querySelector(".grid-author-pill");
          const authorAvatar = el.querySelector(".grid-author-avatar");
          const authorLabel = el.querySelector(".grid-author-label");
          const authorName = (item.bookmark.authorName || "").trim();
          const authorHandle = (item.bookmark.authorHandle || "").trim();
          const authorText = authorName || (authorHandle ? `@${authorHandle}` : "");

          if (authorText) {
            authorLabel.textContent = authorText;
            authorPill.style.display = "";
            authorPill.disabled = Boolean(boardState.active);
            authorPill.setAttribute("aria-disabled", String(Boolean(boardState.active)));
            authorPill.setAttribute("aria-label", boardState.active ? `Source: ${authorText}` : `Filter by ${authorText}`);

            if (item.bookmark.authorAvatar) {
              authorAvatar.src = item.bookmark.authorAvatar;
              authorAvatar.alt = "";
              authorAvatar.style.display = "";
            } else {
              authorAvatar.src = "";
              authorAvatar.style.display = "none";
            }
          } else {
            authorLabel.textContent = "";
            authorAvatar.src = "";
            authorPill.style.display = "none";
            authorPill.disabled = Boolean(boardState.active);
            authorPill.setAttribute("aria-disabled", String(Boolean(boardState.active)));
          }

          el.style.width = `${item.w}px`;
          el.style.height = `${item.h}px`;
          el.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
          el.setAttribute("aria-label", `Open ${item.bookmark.text || "saved inspiration item"}`);

          elToBookmark.set(el, item.bookmark);
          activeMap.set(visKey, {
            poolEl: el,
            layoutItem: item,
            screenX: sx,
            screenY: sy,
          });
        }
      }
    }
  }

  // Release elements that are no longer visible
  // But never release the element the lightbox is using
  for (const [visKey, entry] of activeMap) {
    if (!visibleThisFrame.has(visKey) && entry.poolEl !== lightboxEl) {
      releaseElement(entry.poolEl);
      elToBookmark.delete(entry.poolEl);
      activeMap.delete(visKey);
    }
  }

  debugState.renderedItems = renderedCount;
  debugState.tileCount = (endTileX - startTileX + 1) * (endTileY - startTileY + 1);
  debugState.startTileX = startTileX;
  debugState.endTileX = endTileX;
  debugState.startTileY = startTileY;
  debugState.endTileY = endTileY;
  updateDebugHud();
};

// --- Lightbox ---

const DRAG_THRESHOLD = 5;
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let lightboxClone = null;
let lightboxPreviousFocus = null;
let clipPreviousFocus = null;

const setLightboxAccessibility = (isOpen) => {
  if (!overlay) return;
  if (isOpen) {
    overlay.hidden = false;
    overlay.removeAttribute("inert");
    overlay.removeAttribute("aria-hidden");
    return;
  }

  overlay.hidden = true;
  overlay.setAttribute("inert", "");
  overlay.setAttribute("aria-hidden", "true");
};

setLightboxAccessibility(false);

const lightboxTransform = (x, y, visualW, baseW, visualH, baseH) => {
  const scaleX = visualW / Math.max(1, baseW);
  const scaleY = visualH / Math.max(1, baseH);
  return `translate3d(${x}px, ${y}px, 0) scale(${scaleX}, ${scaleY})`;
};

const setLightboxCloneBaseSize = (width, height) => {
  lightboxClone.style.width = `${width}px`;
  lightboxClone.style.height = `${height}px`;
};

const getFocusableElements = (scope) =>
  [...(scope?.querySelectorAll(FOCUSABLE_SELECTOR) || [])]
    .filter((element) => element.offsetParent !== null || element === document.activeElement);

const trapFocusWithin = (e, scope) => {
  const focusable = getFocusableElements(scope);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
};

const trapLightboxFocus = (e) => {
  if (!state.lightboxOpen) return;
  trapFocusWithin(e, overlay);
};

const getLightboxBookmarkIndex = (bookmark) =>
  BOOKMARKS_WITH_IMAGES.findIndex((item) => item.id === bookmark?.id);

const updateLightboxNav = (bookmark) => {
  const index = getLightboxBookmarkIndex(bookmark);
  const hasIndex = index >= 0;
  if (lightboxPrev) lightboxPrev.disabled = !hasIndex || index === 0;
  if (lightboxNext) lightboxNext.disabled = !hasIndex || index >= BOOKMARKS_WITH_IMAGES.length - 1;
};

const addLightboxPlayButton = (bookmark) => {
  if (!lightboxClone || !bookmark?.images?.[0]) return;
  const media = bookmark.images[0];
  if (media.type !== "video" && media.type !== "animated_gif") return;

  const playBtn = document.createElement("button");
  playBtn.className = "lightbox-play-btn";
  playBtn.innerHTML = `<span class="play-pill"><img src="assets/play-icon.svg" class="play-pill-icon" alt="" aria-hidden="true"><span>Open video source</span></span>`;
  playBtn.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;z-index:2;pointer-events:auto;";
  playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    emitSound("folder-select");
    window.open(bookmark.url, "_blank");
  });
  lightboxClone.appendChild(playBtn);
};

const renderLightboxMedia = (bookmark, shouldAnimate = false) => {
  if (!lightboxClone || !bookmark?.images?.[0]) return Promise.resolve();

  const media = bookmark.images[0];
  lightboxClone.querySelector(".grid-author-pill")?.remove();
  lightboxClone.querySelector(".lightbox-play-btn")?.remove();
  lightboxClone.querySelectorAll(".lightbox-hires").forEach((node) => node.remove());

  const baseImg = [...lightboxClone.querySelectorAll("img")]
    .find((img) => !img.classList.contains("play-pill-icon"));
  if (baseImg) {
    baseImg.src = mediaImageUrl(media.url, "4096x4096");
    baseImg.alt = "";
    baseImg.style.opacity = "1";
  }

  addLightboxPlayButton(bookmark);
  setTimeout(() => {
    const pill = lightboxClone?.querySelector(".play-pill");
    if (pill) pill.classList.add("visible");
  }, 160);

  const aspectRatio = media.width && media.height
    ? media.width / media.height
    : lightboxClone.getBoundingClientRect().width / Math.max(1, lightboxClone.getBoundingClientRect().height);
  const targetRect = getLightboxTargetRect(window.innerWidth, window.innerHeight, aspectRatio);
  const targetW = targetRect.width;
  const targetH = targetRect.height;
  const endX = targetRect.x;
  const endY = targetRect.y;

  if (!state.lightboxItem) return Promise.resolve();

  if (!shouldAnimate) {
    state.lightboxItem._endX = endX;
    state.lightboxItem._endY = endY;
    state.lightboxItem._endW = targetW;
    state.lightboxItem._endH = targetH;
    return Promise.resolve();
  }

  const fromX = state.lightboxItem._endX;
  const fromY = state.lightboxItem._endY;
  const fromW = state.lightboxItem._endW;
  const fromH = state.lightboxItem._endH;
  state.lightboxItem._endX = endX;
  state.lightboxItem._endY = endY;
  state.lightboxItem._endW = targetW;
  state.lightboxItem._endH = targetH;

  const fromTransform = lightboxTransform(fromX, fromY, fromW, targetW, fromH, targetH);
  const toTransform = lightboxTransform(endX, endY, targetW, targetW, targetH, targetH);
  setLightboxCloneBaseSize(targetW, targetH);
  lightboxClone.style.transform = fromTransform;
  lightboxClone.style.willChange = "transform";
  return Motion.animate(
    lightboxClone,
    {
      transform: [fromTransform, toTransform],
    },
    { type: "spring", duration: 0.32, bounce: 0 }
  ).then(() => {
    if (lightboxClone) lightboxClone.style.willChange = "auto";
  });
};

const populateLightboxInfo = (bookmark) => {
  if (!bookmark) return;

  const card = getPrimaryCardForBookmark(bookmark);
  const descriptionEl = document.getElementById("lightbox-description");
  const visibleSection = document.getElementById("lightbox-visible-section");
  const visibleEl = document.getElementById("lightbox-visible");

  lightboxTitle.textContent = card?.title || bookmark.text || "";
  descriptionEl.textContent = card?.description || bookmark.text || "";
  lightboxLink.href = card?.tweet?.url || bookmark.url;
  lightboxLink.textContent = card?.creator || bookmark.authorName || `@${bookmark.authorHandle}`;

  setMetadataRow("lightbox-source", card?.source || bookmark.sourcePlatform || "Web");
  setMetadataRow("lightbox-category", categoryLabel(card?.category || ""));
  setMetadataRow("lightbox-style", card?.style || []);
  setMetadataRow("lightbox-color", card?.color || []);
  setMetadataRow("lightbox-interaction", card?.interaction || []);

  const visibleItems = metadataValues(card?.visible || [], 3);
  if (visibleItems.length > 0) {
    visibleSection.hidden = false;
    visibleEl.textContent = visibleItems.join(" ");
  } else {
    visibleSection.hidden = true;
    visibleEl.textContent = "";
  }

  const avatar = document.getElementById("lightbox-avatar");
  const avatarUrl = card?.author?.avatarUrl || bookmark.authorAvatar;
  if (avatarUrl) {
    avatar.src = avatarUrl;
    avatar.alt = card?.author?.name || bookmark.authorName || bookmark.authorHandle;
    avatar.style.display = "";
  } else {
    avatar.style.display = "none";
  }

  const dateEl = document.getElementById("lightbox-date");
  if (bookmark.postedAt) {
    const d = new Date(bookmark.postedAt);
    dateEl.textContent = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } else {
    dateEl.textContent = "";
  }

  const tagsEl = document.getElementById("lightbox-tags");
  tagsEl.innerHTML = "";
  for (const tag of getDisplayTagsForBookmark(bookmark)) {
    const pill = document.createElement("span");
    pill.className = "lightbox-tag";
    pill.textContent = tag;
    tagsEl.appendChild(pill);
  }

  const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
  document.getElementById("stat-likes-count").textContent = fmt(bookmark.likeCount || 0);
  document.getElementById("stat-retweets-count").textContent = fmt(bookmark.repostCount || 0);
  document.getElementById("stat-bookmarks-count").textContent = fmt(bookmark.bookmarkCount || 0);
  renderManualNote(bookmark);
  renderBoardCuration();
  updateLightboxNav(bookmark);
};

const openLightbox = (el, bookmark) => {
  if (state.lightboxOpen || state.lightboxAnimating) return;
  lightboxPreviousFocus = document.activeElement;

  state.lightboxAnimating = true;
  state.lightboxOpen = true;
  state.lightboxItem = { element: el, bookmark };

  const rect = el.getBoundingClientRect();

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const media = bookmark.images?.[0];
  const aspectRatio = media?.width && media?.height
    ? media.width / media.height
    : rect.width / rect.height;
  const targetRect = getLightboxTargetRect(vw, vh, aspectRatio);
  const targetW = targetRect.width;
  const targetH = targetRect.height;

  const startX = rect.left;
  const startY = rect.top;
  const startW = rect.width;
  const startH = rect.height;
  const endX = targetRect.x;
  const endY = targetRect.y;

  el.style.visibility = "hidden";

  lightboxClone = el.cloneNode(true);
  lightboxClone.classList.add("lightbox-active");
  setLightboxCloneBaseSize(targetW, targetH);
  lightboxClone.style.display = "";
  lightboxClone.style.visibility = "visible";
  const startTransform = lightboxTransform(startX, startY, startW, targetW, startH, targetH);
  const endTransform = lightboxTransform(endX, endY, targetW, targetW, targetH, targetH);
  lightboxClone.style.transform = startTransform;
  lightboxClone.querySelector(".grid-author-pill")?.remove();
  document.body.appendChild(lightboxClone);

  setLightboxAccessibility(true);
  overlay.classList.add("active");
  emitSound("lightbox-open");

  populateLightboxInfo(bookmark);

  // Store for close animation
  state.lightboxItem._startX = startX;
  state.lightboxItem._startY = startY;
  state.lightboxItem._startW = startW;
  state.lightboxItem._startH = startH;
  state.lightboxItem._endX = endX;
  state.lightboxItem._endY = endY;
  state.lightboxItem._endW = targetW;
  state.lightboxItem._endH = targetH;
  void renderLightboxMedia(bookmark, false);

  // Scale duration with travel distance so far items don't rush
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const baseDuration = 0.45;
  const springDuration = baseDuration + Math.min(distance / 2000, 0.25);
  const springTransition = { type: "spring", duration: springDuration, bounce: 0 };

  lightboxClone.style.willChange = "transform";

  Motion.animate(
    lightboxClone,
    {
      transform: [startTransform, endTransform],
    },
    springTransition
  ).then(() => {
    lightboxClone.style.willChange = "auto";
    state.lightboxAnimating = false;
    lightboxClose.focus();
  });

};

const closeLightbox = () => {
  if (!state.lightboxOpen || state.lightboxAnimating || !state.lightboxItem)
    return;

  state.lightboxAnimating = true;
  const { element: el } = state.lightboxItem;

  // Hide play pill immediately
  const pill = lightboxClone?.querySelector(".play-pill");
  if (pill) pill.classList.remove("visible");

  overlay.classList.remove("active");

  // Animate from current lightbox size back to the grid element's position
  const originalRect = el.getBoundingClientRect();
  const endX = originalRect.left;
  const endY = originalRect.top;
  const endW = originalRect.width;
  const endH = originalRect.height;

  const fromX = state.lightboxItem._endX;
  const fromY = state.lightboxItem._endY;
  const fromW = state.lightboxItem._endW;
  const fromH = state.lightboxItem._endH;

  const closeTransition = { type: "spring", duration: 0.4, bounce: 0 };
  const fromTransform = lightboxTransform(fromX, fromY, fromW, fromW, fromH, fromH);
  const endTransform = lightboxTransform(endX, endY, endW, fromW, endH, fromH);

  emitSound("lightbox-close");
  setLightboxCloneBaseSize(fromW, fromH);
  lightboxClone.style.transform = fromTransform;
  lightboxClone.style.willChange = "transform";

  Motion.animate(
    lightboxClone,
    {
      transform: [fromTransform, endTransform],
    },
    closeTransition
  ).then(() => {
    lightboxClone.remove();
    lightboxClone = null;
    el.style.visibility = "";
    state.lightboxOpen = false;
    state.lightboxItem = null;
    state.lightboxAnimating = false;
    setLightboxAccessibility(false);
    if (lightboxPreviousFocus && lightboxPreviousFocus.focus) {
      lightboxPreviousFocus.focus();
    }
    lightboxPreviousFocus = null;
    if (webClipRenderPending) {
      webClipRenderPending = false;
      rebuildGrid(false);
      updateDebugHud();
    }
  });
};

const navigateLightbox = (direction) => {
  if (!state.lightboxOpen || state.lightboxAnimating || !state.lightboxItem) return;
  const index = getLightboxBookmarkIndex(state.lightboxItem.bookmark);
  const nextBookmark = BOOKMARKS_WITH_IMAGES[index + direction];
  if (!nextBookmark) return;

  state.lightboxAnimating = true;
  state.lightboxItem.bookmark = nextBookmark;
  emitSound("lightbox-nav");
  populateLightboxInfo(nextBookmark);
  renderLightboxMedia(nextBookmark, true).finally(() => {
    state.lightboxAnimating = false;
    lightboxClose.focus();
  });
};

// --- Input Handlers ---

const onMouseDown = (e) => {
  if (state.lightboxOpen) return;
  state.isDragging = true;
  state.hasDragged = false;
  state.dragStartPosition = { x: e.clientX, y: e.clientY };
  viewport.classList.add("grabbing");
  state.previousMousePosition = { x: e.clientX, y: e.clientY };
};

const onMouseMove = (e) => {
  if (!state.isDragging) return;

  const totalDx = e.clientX - state.dragStartPosition.x;
  const totalDy = e.clientY - state.dragStartPosition.y;
  if (Math.sqrt(totalDx * totalDx + totalDy * totalDy) > DRAG_THRESHOLD) {
    state.hasDragged = true;
  }

  const deltaX = e.clientX - state.previousMousePosition.x;
  const deltaY = e.clientY - state.previousMousePosition.y;

  state.targetOffset.x -= deltaX;
  state.targetOffset.y -= deltaY;

  state.previousMousePosition = { x: e.clientX, y: e.clientY };
};

const onMouseUp = (e) => {
  const wasDragging = state.isDragging;
  state.isDragging = false;
  viewport.classList.remove("grabbing");

  if (wasDragging && !state.hasDragged && !state.lightboxOpen) {
    const target = e.target.closest(".grid-item");
    if (target) {
      const bookmark = elToBookmark.get(target);
      if (bookmark) openLightbox(target, bookmark);
    }
  }
};

const onTouchStart = (e) => {
  if (e.touches.length === 1) {
    state.touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
};

const onTouchMove = (e) => {
  if (e.touches.length === 1 && state.touchStart) {
    e.preventDefault();
    const deltaX = e.touches[0].clientX - state.touchStart.x;
    const deltaY = e.touches[0].clientY - state.touchStart.y;

    state.targetOffset.x -= deltaX;
    state.targetOffset.y -= deltaY;

    state.touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
};

const onTouchEnd = () => {
  state.touchStart = null;
};

const onWheel = (e) => {
  e.preventDefault();
  if (state.lightboxOpen) return;
  state.targetOffset.x += e.deltaX;
  state.targetOffset.y += e.deltaY;
};

const onWindowResize = () => {
  buildMasonryLayout();
  // Return all active elements to pool
  for (const [visKey, entry] of activeMap) {
    releaseElement(entry.poolEl);
    activeMap.delete(visKey);
  }
  renderVisibleItems();
};

// --- Animation Loop ---

const animate = () => {
  requestAnimationFrame(animate);
  debugState.frames++;

  const dx = state.targetOffset.x - state.cameraOffset.x;
  const dy = state.targetOffset.y - state.cameraOffset.y;

  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
    state.cameraOffset.x += dx * CONFIG.easingFactor;
    state.cameraOffset.y += dy * CONFIG.easingFactor;
    renderVisibleItems();
  }
};

// --- Filtering ---

const filterTransition = {
  applyTimer: null,
  cleanupTimer: null,
};
const reduceFilterMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const filterBookmarks = () => {
  const query = activeSearch.toLowerCase();
  return ALL_BOOKMARKS.filter((b) => {
    if (!b.images || b.images.length === 0) return false;
    if (!bookmarkMatchesMetadataFilter(b)) return false;
    if (activeAuthorKey && getAuthorKey(b) !== activeAuthorKey) return false;
    if (query) {
      const haystack = `${b.text} ${b.authorName} ${b.authorHandle} ${getBookmarkMetadataText(b)}`.toLowerCase();
      // All search terms must match (AND logic)
      const terms = query.split(/\s+/).filter(Boolean);
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
};

const rebuildGrid = (resetCamera = true) => {
  if (resetCamera) {
    state.cameraOffset.x = 0;
    state.cameraOffset.y = 0;
    state.targetOffset.x = 0;
    state.targetOffset.y = 0;
  }

  for (const [visKey, entry] of activeMap) {
    releaseElement(entry.poolEl);
    activeMap.delete(visKey);
  }

  buildMasonryLayout();
  renderVisibleItems();
};

const commitActiveFilters = () => {
  if (boardState.active) return;
  BOOKMARKS_WITH_IMAGES = filterBookmarks();
  rebuildGrid();
  updateAuthorPill();
  updateSearchLiveRegion();
};

const clearFilterTransitionTimers = () => {
  clearTimeout(filterTransition.applyTimer);
  clearTimeout(filterTransition.cleanupTimer);
  filterTransition.applyTimer = null;
  filterTransition.cleanupTimer = null;
};

const applyFilterAnimated = () => {
  clearFilterTransitionTimers();

  if (reduceFilterMotion.matches) {
    grid.style.transition = "";
    grid.style.willChange = "";
    grid.style.opacity = "1";
    commitActiveFilters();
    return;
  }

  grid.style.willChange = "opacity";
  grid.style.transition = "opacity 0.16s ease-out";
  grid.style.opacity = "0";

  filterTransition.applyTimer = setTimeout(() => {
    filterTransition.applyTimer = null;
    commitActiveFilters();

    void grid.offsetHeight;
    grid.style.transition = "opacity 0.22s ease-out";
    grid.style.opacity = "1";

    filterTransition.cleanupTimer = setTimeout(() => {
      filterTransition.cleanupTimer = null;
      grid.style.transition = "";
      grid.style.willChange = "";
    }, 220);
  }, 160);
};

// Keep this curated order stable so counts never reshuffle the topbar.
const FILTER_OPTIONS = [
  { key: "web", label: "Web", matches: [{ group: "category", value: "Website" }, { group: "collection", value: "Website" }] },
  { key: "interface", label: "Interface", matches: [{ group: "category", value: "Interface" }, { group: "collection", value: "Interface" }] },
  { key: "branding", label: "Branding", matches: [{ group: "category", value: "Branding" }, { group: "collection", value: "Branding" }] },
  { key: "product", label: "Product", matches: [{ group: "category", value: "Product" }, { group: "collection", value: "Product" }, { group: "text", value: "product" }] },
  { key: "workspace", label: "Workspace", matches: [{ group: "category", value: "Workspace" }, { group: "collection", value: "Workspace" }, { group: "collection", value: "Studio Display" }, { group: "text", value: "desk" }, { group: "text", value: "workspace" }] },
  { key: "typography", label: "Typography", matches: [{ group: "category", value: "Typography" }, { group: "collection", value: "Typography" }, { group: "text", value: "typography" }, { group: "text", value: "typeface" }] },
  { key: "motion", label: "Motion", matches: [{ group: "interaction", value: "Motion" }, { group: "text", value: "motion" }, { group: "text", value: "animation" }] },
  { key: "illustration", label: "Illustration", matches: [{ group: "category", value: "Illustration" }, { group: "collection", value: "Illustration" }, { group: "text", value: "illustration" }] },
  { key: "3d", label: "3D", matches: [{ group: "style", value: "3D" }, { group: "text", value: "3d" }] },
  { key: "editorial", label: "Editorial", matches: [{ group: "style", value: "Editorial" }, { group: "text", value: "editorial" }] },
  { key: "print", label: "Print", matches: [{ group: "text", value: "print" }] },
  { key: "packaging", label: "Packaging", matches: [{ group: "text", value: "packaging" }] },
];

const filterKey = (filter) => filter.key || `${filter.group}:${filter.value}`;

const getMetadataFilterCount = (filter) =>
  ALL_BOOKMARKS.reduce((total, bookmark) => {
    if (!bookmark.images || bookmark.images.length === 0) return total;
    return total + (bookmarkMatchesFilter(bookmark, filter) ? 1 : 0);
  }, 0);

const buildFilterOptions = () => {
  const options = [{ type: "all", label: "All", count: getMetadataFilterCount(null) }];

  for (const option of FILTER_OPTIONS) {
    options.push({ ...option, count: getMetadataFilterCount(option) });
  }

  return options;
};

const updateFilterChips = () => {
  const chips = document.querySelectorAll(".filter-chip");
  for (const chip of chips) {
    const key = chip.dataset.filterKey || "";
    const active = activeMetadataFilter ? key === filterKey(activeMetadataFilter) : key === "all";
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  }
};

const setMetadataFilter = (filter) => {
  const nextFilter = filter?.type === "all" ? null : filter;
  const currentKey = activeMetadataFilter ? filterKey(activeMetadataFilter) : "all";
  const nextKey = nextFilter ? filterKey(nextFilter) : "all";
  if (currentKey === nextKey) return;
  activeMetadataFilter = nextFilter;
  updateFilterChips();
  emitSound("folder-select");
  applyFilterAnimated();
};

const createDesignTopbar = () => {
  const chipContainer = document.getElementById("filter-chips");
  if (!chipContainer) return;

  chipContainer.innerHTML = "";
  for (const [index, option] of buildFilterOptions().entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    button.dataset.filterKey = option.type === "all" ? "all" : filterKey(option);
    button.setAttribute("aria-pressed", option.type === "all" ? "true" : "false");
    button.setAttribute(
      "aria-label",
      option.type === "all"
        ? `Show all design inspiration (${bookmarkCountLabel(option.count)})`
        : `Filter by ${option.label} (${bookmarkCountLabel(option.count)})`
    );
    button.title = bookmarkCountLabel(option.count);

    const label = document.createElement("span");
    label.className = "filter-chip-label";
    label.textContent = option.label;

    const count = document.createElement("span");
    count.className = "filter-chip-count";
    count.setAttribute("aria-hidden", "true");
    count.textContent = String(option.count);

    button.append(label, count);
    button.addEventListener("pointerenter", () => emitSound("menu-hover", { index }));
    button.addEventListener("click", () => setMetadataFilter(option));
    chipContainer.appendChild(button);
  }

  updateFilterChips();
};

const clearAuthorFilter = () => {
  if (!activeAuthorKey) return;
  activeAuthorKey = "";
  activeAuthorLabel = "";
  activeAuthorAvatar = "";
  emitSound("folder-select");
  applyFilterAnimated();
};

const setAuthorFilter = (bookmark) => {
  const nextAuthorKey = getAuthorKey(bookmark);
  const nextAuthorLabel = getAuthorLabel(bookmark);
  if (!nextAuthorKey) return;

  if (activeAuthorKey === nextAuthorKey) {
    clearAuthorFilter();
    return;
  }

  activeAuthorKey = nextAuthorKey;
  activeAuthorLabel = nextAuthorLabel;
  activeAuthorAvatar = bookmark.authorAvatar || "";
  emitSound("folder-select");
  applyFilterAnimated();
};

const createAuthorFilterPill = () => {
  const pill = document.createElement("button");
  pill.id = "author-filter-pill";
  pill.className = "author-filter-pill";
  pill.type = "button";
  pill.hidden = true;
  pill.setAttribute("aria-label", "Clear author filter");
  pill.innerHTML = `<img id="author-filter-pill-avatar" class="author-filter-pill-avatar" src="" alt=""><span id="author-filter-pill-label"></span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="3" x2="9" y2="9"></line><line x1="9" y1="3" x2="3" y2="9"></line></svg>`;
  pill.addEventListener("click", clearAuthorFilter);
  document.body.appendChild(pill);
};

const updateAuthorPill = () => {
  const pill = document.getElementById("author-filter-pill");
  const label = document.getElementById("author-filter-pill-label");
  const avatar = document.getElementById("author-filter-pill-avatar");
  if (!pill || !label || !avatar) return;

  if (!activeAuthorKey) {
    pill.hidden = true;
    label.textContent = "";
    avatar.src = "";
    avatar.style.display = "none";
    return;
  }

  const count = getAuthorCount(activeAuthorKey);
  label.textContent = `${activeAuthorLabel} · ${count}`;
  if (activeAuthorAvatar) {
    avatar.src = activeAuthorAvatar;
    avatar.style.display = "";
  } else {
    avatar.src = "";
    avatar.style.display = "none";
  }
  pill.hidden = false;
};

// --- Search ---

let searchDebounce = null;

const initSearch = () => {
  const input = document.getElementById("search-input");

  input.addEventListener("input", () => {
    const value = input.value.trim();
    if (value === activeSearch) return;
    activeSearch = value;
    emitSound("search-type", { length: value.length });

    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      applyFilterAnimated();
    }, 200);
  });

  // Cmd+K / Ctrl+K to focus (but not when lightbox is open)
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      if (!state.lightboxOpen) {
        input.focus();
        input.select();
      }
    }
  });

  // Escape blurs and clears the search, but closing the lightbox takes priority.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.lightboxOpen) {
        input.blur();
        return; // let the window handler close the lightbox
      }
      e.stopPropagation();
      if (input.value) {
        input.value = "";
        activeSearch = "";
        applyFilterAnimated();
      } else {
        input.blur();
      }
    }
  });

  // Prevent grid panning while typing
  input.addEventListener("mousedown", (e) => e.stopPropagation());
};

const setClipStatus = (message, type = "") => {
  if (!clipStatus) return;
  clipStatus.textContent = message || "";
  clipStatus.classList.toggle("error", type === "error");
  if (clipUrlInput) clipUrlInput.setAttribute("aria-invalid", String(type === "error"));
};

const setClipSaving = (saving) => {
  if (clipSave) clipSave.disabled = saving;
  if (clipCancel) clipCancel.disabled = saving;
  if (clipClose) clipClose.disabled = saving;
  if (clipUrlInput) clipUrlInput.disabled = saving;
  if (clipTagsInput) clipTagsInput.disabled = saving;
  if (clipNoteInput) clipNoteInput.disabled = saving;
  if (clipForm) clipForm.setAttribute("aria-busy", String(saving));
};

const renderClipPreview = (clip) => {
  if (!clipPreview || !clipPreviewImage || !clipPreviewTitle || !clipPreviewMeta) return;
  if (!clip) {
    clipPreview.hidden = true;
    clipPreviewImage.src = "";
    clipPreviewTitle.textContent = "";
    clipPreviewMeta.textContent = "";
    return;
  }

  clipPreview.hidden = false;
  clipPreviewImage.src = clip.media?.url || clip.avatar?.url || "";
  clipPreviewImage.alt = "";
  clipPreviewTitle.textContent = clip.title || clip.canonicalUrl || "Saved URL";
  clipPreviewMeta.textContent = [clip.sourcePlatform, clip.siteName || clip.host].filter(Boolean).join(" · ");
};

const openClipModal = () => {
  if (!clipModal || !clipUrlInput) return;
  clipPreviousFocus = document.activeElement;
  clipModal.hidden = false;
  clipForm?.reset();
  renderClipPreview(null);
  setClipStatus("");
  setClipSaving(false);
  requestAnimationFrame(() => clipUrlInput.focus());
};

const closeClipModal = () => {
  if (!clipModal) return;
  clipModal.hidden = true;
  setClipStatus("");
  setClipSaving(false);
  if (clipPreviousFocus && clipPreviousFocus.focus) {
    clipPreviousFocus.focus();
  }
  clipPreviousFocus = null;
};

const saveClipFromForm = async () => {
  if (PUBLIC_DEMO) return;
  if (!clipUrlInput) return;
  if (window.location.protocol === "file:") {
    setClipStatus("Start the local server to save URLs.", "error");
    return;
  }

  const url = clipUrlInput.value.trim();
  if (!url) {
    setClipStatus("Paste a URL first.", "error");
    clipUrlInput.focus();
    return;
  }

  setClipSaving(true);
  setClipStatus("Fetching page metadata...");
  renderClipPreview(null);

  try {
    const response = await fetch("./api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clip: {
          url,
          tags: clipTagsInput?.value || "",
          note: clipNoteInput?.value || "",
        },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok || !result.clip) {
      throw new Error(result.error || "Could not save URL.");
    }

    upsertWebClip(result.clip, { prepend: true });
    webClipSignature = webClipListSignature(WEB_CLIPS);
    BOOKMARKS_WITH_IMAGES = filterBookmarks();
    rebuildGrid();
    createDesignTopbar();
    updateSearchLiveRegion();
    renderClipPreview(result.clip);
    setClipStatus("Saved to your inspiration grid.");
    emitSound("folder-select");
  } catch (error) {
    setClipStatus(error.message || "Could not save URL.", "error");
  } finally {
    setClipSaving(false);
  }
};

const initClipFlow = () => {
  if (PUBLIC_DEMO) {
    if (clipAddButton) clipAddButton.hidden = true;
    if (clipModal) clipModal.hidden = true;
    return;
  }
  if (!clipAddButton || !clipModal || !clipForm) return;

  clipAddButton.addEventListener("click", (e) => {
    e.stopPropagation();
    emitSound("folder-open");
    openClipModal();
  });

  clipClose?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeClipModal();
  });

  clipCancel?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeClipModal();
  });

  clipModal.addEventListener("click", (e) => {
    if (e.target === clipModal) closeClipModal();
  });

  clipForm.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void saveClipFromForm();
  });

  clipForm.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeClipModal();
      return;
    }
    if (e.key === "Tab") {
      trapFocusWithin(e, clipForm);
    }
  });
};

// --- Boards ---

const announceBoard = (message) => {
  if (boardLive) boardLive.textContent = message || "";
};

const setBoardDialogStatus = (message, type = "") => {
  if (!boardDialogStatus) return;
  boardDialogStatus.textContent = message || "";
  boardDialogStatus.classList.toggle("error", type === "error");
};

const boardRequest = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || "Board request failed.");
  return payload;
};

const resolverSelectorForBookmark = (bookmark, clientKey) => {
  return runtimeBrowserLoader()?.resolverSelectorForRuntime(bookmark, clientKey) || null;
};

const currentBoardQuerySnapshot = () => ({
  query: activeSearch,
  filters: activeMetadataFilter ? { key: filterKey(activeMetadataFilter), label: activeMetadataFilter.label } : {},
  author: activeAuthorKey ? { key: activeAuthorKey, label: activeAuthorLabel } : {},
  limit: BOARD_DIALOG_MAX_ITEMS,
});

const boundedMatchReasons = () => {
  const reasons = [];
  if (activeSearch) reasons.push(`query: ${activeSearch}`);
  if (activeMetadataFilter?.label) reasons.push(`filter: ${activeMetadataFilter.label}`);
  if (activeAuthorLabel) reasons.push(`author: ${activeAuthorLabel}`);
  return [...new Set(reasons.map((reason) => Array.from(reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()).slice(0, 240).join("")))]
    .filter(Boolean)
    .slice(0, 12);
};

const renderBoardCandidates = () => {
  if (!boardSelectionList) return;
  boardSelectionList.innerHTML = "";
  for (const candidate of boardState.candidates) {
    const label = document.createElement("label");
    label.className = "board-selection-item";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "board-item";
    input.value = candidate.catalogId;
    input.checked = true;
    const copy = document.createElement("span");
    copy.className = "board-selection-copy";
    copy.textContent = candidate.title;
    label.append(input, copy);
    boardSelectionList.appendChild(label);
  }
};

const setBoardFieldInvalid = (element, invalid) => {
  if (element) element.setAttribute("aria-invalid", String(Boolean(invalid)));
};

const setBoardDialogBusy = (mode = "") => {
  boardState.modalBusy = mode;
  const busy = Boolean(mode);
  if (boardForm) boardForm.setAttribute("aria-busy", String(busy));
  if (boardSave) boardSave.disabled = busy;
  const lockForm = mode === "save";
  [boardNameInput, boardBriefInput, boardDialogClose, boardCancel].forEach((element) => {
    if (element) element.disabled = lockForm;
  });
  boardSelectionList?.querySelectorAll("input").forEach((input) => { input.disabled = busy; });
};

const hideBoardModalBackground = () => {
  if (!boardModal || boardState.modalBackground.length) return;
  boardState.modalBackground = [...document.body.children]
    .filter((element) => element !== boardModal)
    .map((element) => ({
      element,
      hadInert: element.hasAttribute("inert"),
      inertValue: element.getAttribute("inert"),
      hadAriaHidden: element.hasAttribute("aria-hidden"),
      ariaHiddenValue: element.getAttribute("aria-hidden"),
    }));
  for (const state of boardState.modalBackground) {
    state.element.setAttribute("inert", "");
    state.element.setAttribute("aria-hidden", "true");
  }
};

const restoreBoardModalBackground = () => {
  for (const state of boardState.modalBackground) {
    if (state.hadInert) state.element.setAttribute("inert", state.inertValue || "");
    else state.element.removeAttribute("inert");
    if (state.hadAriaHidden) state.element.setAttribute("aria-hidden", state.ariaHiddenValue || "");
    else state.element.removeAttribute("aria-hidden");
  }
  boardState.modalBackground = [];
};

const closeBoardModal = ({ restoreFocus = true } = {}) => {
  if (!boardModal) return;
  if (boardState.modalBusy === "save") return;
  boardState.modalRequestId += 1;
  boardModal.hidden = true;
  boardModal.setAttribute("inert", "");
  boardModal.setAttribute("aria-hidden", "true");
  restoreBoardModalBackground();
  boardState.candidates = [];
  boardState.editMode = false;
  setBoardDialogBusy();
  setBoardDialogStatus("");
  setBoardFieldInvalid(boardNameInput, false);
  setBoardFieldInvalid(boardBriefInput, false);
  if (restoreFocus && boardState.previousFocus?.focus) boardState.previousFocus.focus();
  boardState.previousFocus = null;
};

const openBoardModal = async ({ edit = false } = {}) => {
  if (!boardModal || !boardForm || !boardNameInput || !boardBriefInput) return;
  if (window.location.protocol === "file:") {
    announceBoard("Start the local server to create boards.");
    return;
  }
  boardState.previousFocus = document.activeElement;
  const requestId = ++boardState.modalRequestId;
  boardState.editMode = edit;
  boardModal.hidden = false;
  boardModal.removeAttribute("inert");
  boardModal.setAttribute("aria-hidden", "false");
  hideBoardModalBackground();
  boardForm.reset();
  setBoardFieldInvalid(boardNameInput, false);
  setBoardFieldInvalid(boardBriefInput, false);
  setBoardDialogStatus("");
  boardSelectionList.innerHTML = "";
  if (boardDialogTitle) boardDialogTitle.textContent = edit ? "Edit board" : "Create board";
  if (boardSave) boardSave.textContent = edit ? "Save" : "Create";
  if (edit && boardState.active) {
    boardNameInput.value = boardState.active.board.name;
    boardBriefInput.value = boardState.active.board.brief;
    if (boardSelectionHeading) boardSelectionHeading.hidden = true;
    boardSelectionList.hidden = true;
    boardUnavailableCount.textContent = "";
    requestAnimationFrame(() => boardNameInput.focus());
    return;
  }

  if (boardSelectionHeading) boardSelectionHeading.hidden = false;
  boardSelectionList.hidden = false;
  setBoardDialogBusy("resolve");
  setBoardDialogStatus("Loading filtered references...");
  requestAnimationFrame(() => boardNameInput.focus());
  const filtered = filterBookmarks().slice(0, BOARD_DIALOG_MAX_ITEMS);
  const prepared = filtered.map((bookmark, index) => ({
    bookmark,
    clientKey: `filtered-result-${index}`,
    selector: resolverSelectorForBookmark(bookmark, `filtered-result-${index}`),
  }));
  const valid = prepared.filter((entry) => entry.selector);
  let resolution = [];
  try {
    if (valid.length > 0) {
      const response = await boardRequest("./api/catalog/resolve", {
        method: "POST",
        body: JSON.stringify({ items: valid.map((entry) => entry.selector) }),
      });
      resolution = response.items || [];
    }
  } catch (error) {
    if (requestId !== boardState.modalRequestId) return;
    setBoardDialogBusy();
    setBoardDialogStatus(error.message || "Could not resolve references.", "error");
    return;
  }
  if (requestId !== boardState.modalRequestId) return;
  const byClientKey = new Map(resolution.map((entry) => [entry.clientKey, entry]));
  boardState.candidates = valid.map((entry) => {
    const result = byClientKey.get(entry.clientKey);
    if (result?.status !== "resolved") return null;
    const card = getPrimaryCardForBookmark(entry.bookmark);
    return {
      catalogId: result.catalogId,
      title: card?.title || entry.bookmark.text || "Untitled reference",
      matchReasonsAtSave: boundedMatchReasons(),
    };
  }).filter(Boolean);
  const unavailable = filtered.length - boardState.candidates.length;
  if (boardUnavailableCount) boardUnavailableCount.textContent = unavailable ? `${unavailable} unavailable` : "";
  renderBoardCandidates();
  setBoardDialogBusy();
  setBoardDialogStatus(boardState.candidates.length ? "Choose references to save." : "No filtered references are available.", boardState.candidates.length ? "" : "error");
};

const setBoardFilterControlsDisabled = (disabled) => {
  if (disabled && !boardState.filterControls) {
    const controls = [
      document.getElementById("search-input"),
      ...document.querySelectorAll(".filter-chip"),
      document.getElementById("author-filter-pill"),
      boardCreateButton,
    ].filter(Boolean);
    boardState.filterControls = controls.map((element) => ({
      element,
      disabled: Boolean(element.disabled),
      hadAriaDisabled: element.hasAttribute("aria-disabled"),
      ariaDisabled: element.getAttribute("aria-disabled"),
    }));
    for (const state of boardState.filterControls) {
      state.element.disabled = true;
      state.element.setAttribute("aria-disabled", "true");
    }
    document.body.classList.add("board-mode");
    return;
  }
  if (!disabled && boardState.filterControls) {
    for (const state of boardState.filterControls) {
      state.element.disabled = state.disabled;
      if (state.hadAriaDisabled) state.element.setAttribute("aria-disabled", state.ariaDisabled || "");
      else state.element.removeAttribute("aria-disabled");
    }
    boardState.filterControls = null;
    document.body.classList.remove("board-mode");
  }
};

const catalogItemToBookmark = (item) => ({
  id: item.id,
  text: item.title || item.description || "Untitled reference",
  url: item.sourceUrl,
  postedAt: item.savedAt || "",
  authorName: item.creatorName || item.sourceName || "Source",
  authorHandle: item.creatorHandle || "",
  authorAvatar: item.creatorAvatarUrl || "",
  folders: item.collections || [],
  tags: item.tags || [],
  sourcePlatform: item.sourceName || item.sourceType || "Source",
  sourceType: item.sourceType,
  sourceRecordId: item.sourceRecordId || "",
  resolverSourceUrl: item.sourceUrl || "",
  images: item.media?.url ? [{ ...item.media, id: item.mediaId }] : [],
  catalogItem: item,
});

const renderBoardHeader = () => {
  if (!boardState.active || !boardHeader) return;
  const available = boardState.active.resolvedItems.filter((entry) => entry.status === "available").length;
  const unavailable = boardState.active.resolvedItems.length - available;
  boardHeader.hidden = false;
  boardHeaderName.textContent = boardState.active.board.name;
  boardHeaderCounts.textContent = unavailable ? `${available} available, ${unavailable} unavailable` : `${available} available`;
  BoardRepair.renderUnavailableRepairs({
    document,
    section: boardUnavailableRepairs,
    list: boardUnavailableRepairsList,
    summary: boardUnavailableRepairsSummary,
    resolvedItems: boardState.active.resolvedItems,
    busy: boardState.repairBusy,
    onAction: (itemId, action, trigger) => { void mutateBoardItem(itemId, action, { repairTrigger: trigger }); },
  });
};

const applyBoardDetail = (detail) => {
  boardState.active = detail;
  setBoardFilterControlsDisabled(true);
  BOOKMARKS_WITH_IMAGES = detail.resolvedItems
    .filter((entry) => entry.status === "available" && entry.item?.media?.url)
    .map((entry) => catalogItemToBookmark(entry.item));
  renderBoardHeader();
  rebuildGrid();
  updateSearchLiveRegion();
};

const openBoard = async (id, { replace = false, updateHistory = true, isCurrent } = {}) => {
  if (!id || window.location.protocol === "file:") return;
  const navigationGeneration = isCurrent ? null : ++boardState.navigationGeneration;
  const navigationIsCurrent = isCurrent || (() => boardState.navigationGeneration === navigationGeneration);
  try {
    const detail = await boardRequest(`./api/boards/${encodeURIComponent(id)}`);
    if (!navigationIsCurrent()) return;
    applyBoardDetail(detail);
    const url = new URL(window.location.href);
    url.searchParams.set("board", detail.board.id);
    if (updateHistory) history[replace ? "replaceState" : "pushState"]({}, "", url);
    announceBoard(`Opened board ${detail.board.name}.`);
    return true;
  } catch (error) {
    announceBoard(error.message || "Could not open board.");
    return false;
  }
};

const exitBoardMode = ({ updateHistory = true, restoreFocus = true } = {}) => {
  boardState.navigationGeneration += 1;
  if (!boardState.active) return;
  boardState.active = null;
  setBoardFilterControlsDisabled(false);
  boardHeader.hidden = true;
  if (boardUnavailableRepairs) boardUnavailableRepairs.hidden = true;
  BOOKMARKS_WITH_IMAGES = filterBookmarks();
  rebuildGrid();
  const url = new URL(window.location.href);
  url.searchParams.delete("board");
  if (updateHistory) history.pushState({}, "", url);
  announceBoard("Closed board.");
  if (restoreFocus) boardCreateButton?.focus();
};

const refreshActiveBoard = async () => {
  if (!boardState.active) return;
  await openBoard(boardState.active.board.id, { replace: true });
};

const restoreBoardRepairFocus = (itemId, action) => {
  requestAnimationFrame(() => {
    const buttons = [...(boardUnavailableRepairsList?.querySelectorAll("button") || [])];
    const preferred = buttons.find((button) => button.dataset.boardRepairItemId === itemId && button.dataset.boardRepairAction === action && !button.disabled);
    (preferred || buttons.find((button) => !button.disabled) || boardCloseButton)?.focus();
  });
};

const mutateBoardItem = async (itemId, action, { closeLightboxAfter = false, repairTrigger = null } = {}) => {
  if (!itemId || !boardState.active || boardState.repairBusy) return;
  const boardId = boardState.active.board.id;
  const items = BoardRepair.itemIdsAfterAction(boardState.active.resolvedItems, itemId, action);
  if (!items) return;
  boardState.repairBusy = true;
  renderBoardHeader();
  try {
    const body = action === "remove"
      ? { action: "remove", itemId }
      : { action: "reorder", itemIds: items };
    await boardRequest(`./api/boards/${encodeURIComponent(boardId)}`, { method: "PATCH", body: JSON.stringify(body) });
    if (closeLightboxAfter) closeLightbox();
    await refreshActiveBoard();
    announceBoard(action === "remove" ? "Reference removed from board." : action === "earlier" ? "Reference moved earlier." : "Reference moved later.");
    if (repairTrigger) restoreBoardRepairFocus(itemId, action);
  } catch (error) {
    announceBoard(error.message || "Could not update board.");
  } finally {
    boardState.repairBusy = false;
    if (boardState.active) renderBoardHeader();
  }
};

const currentBoardLightboxEntry = () => boardState.active?.resolvedItems.find((entry) => entry.itemId === state.lightboxItem?.bookmark?.id) || null;

const renderBoardCuration = () => {
  const entry = currentBoardLightboxEntry();
  if (!boardCurationSection) return;
  if (!entry) {
    boardCurationSection.hidden = true;
    return;
  }
  boardCurationSection.hidden = false;
  boardCurationForm.hidden = true;
  boardCurationEdit.hidden = false;
  boardCurationText.hidden = false;
  boardCurationText.textContent = entry.curationNote || entry.matchReasonsAtSave[0] || "No board note yet.";
  boardCurationText.classList.toggle("empty", !entry.curationNote && !entry.matchReasonsAtSave.length);
  boardCurationInput.value = entry.curationNote || "";
  boardCurationStatus.textContent = "";
  boardCurationStatus.classList.remove("error");
  const index = boardState.active.resolvedItems.findIndex((candidate) => candidate.itemId === entry.itemId);
  boardMoveEarlier.disabled = index <= 0;
  boardMoveLater.disabled = index < 0 || index >= boardState.active.resolvedItems.length - 1;
};

const updateBoardCuration = async () => {
  const entry = currentBoardLightboxEntry();
  if (!entry || !boardState.active) return;
  boardCurationSave.disabled = true;
  boardCurationCancel.disabled = true;
  boardCurationInput.disabled = true;
  boardCurationForm.setAttribute("aria-busy", "true");
  try {
    const response = await boardRequest(`./api/boards/${encodeURIComponent(boardState.active.board.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "curation-note", itemId: entry.itemId, curationNote: boardCurationInput.value.trim() }),
    });
    boardState.active.board = response.board;
    const activeEntry = boardState.active.resolvedItems.find((candidate) => candidate.itemId === entry.itemId);
    if (activeEntry) activeEntry.curationNote = boardCurationInput.value.trim();
    renderBoardCuration();
    boardState.curationTrigger?.focus();
    boardState.curationTrigger = null;
    announceBoard("Board note saved.");
  } catch (error) {
    boardCurationStatus.textContent = error.message || "Could not save board note.";
    boardCurationStatus.classList.add("error");
  } finally {
    boardCurationSave.disabled = false;
    boardCurationCancel.disabled = false;
    boardCurationInput.disabled = false;
    boardCurationForm.setAttribute("aria-busy", "false");
  }
};

const mutateBoardOrder = async (action) => {
  const entry = currentBoardLightboxEntry();
  if (!entry || !boardState.active) return;
  await mutateBoardItem(entry.itemId, action, { closeLightboxAfter: true });
};

const submitBoardForm = async () => {
  if (!boardNameInput?.value.trim()) {
    setBoardDialogStatus("Name is required.", "error");
    setBoardFieldInvalid(boardNameInput, true);
    boardNameInput?.focus();
    return;
  }
  setBoardFieldInvalid(boardNameInput, false);
  setBoardFieldInvalid(boardBriefInput, false);
  setBoardDialogBusy("save");
  try {
    if (boardState.editMode && boardState.active) {
      const response = await boardRequest(`./api/boards/${encodeURIComponent(boardState.active.board.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: boardNameInput.value.trim(), brief: boardBriefInput.value.trim() }),
      });
      boardState.active.board = response.board;
      renderBoardHeader();
      setBoardDialogBusy();
      closeBoardModal();
      announceBoard("Board updated.");
      return;
    }
    const selectedIds = [...boardSelectionList.querySelectorAll("input:checked")].map((input) => input.value);
    if (selectedIds.length === 0) throw new Error("Choose at least one reference.");
    const candidates = new Map(boardState.candidates.map((candidate) => [candidate.catalogId, candidate]));
    const response = await boardRequest("./api/boards", {
      method: "POST",
      body: JSON.stringify({
        name: boardNameInput.value.trim(),
        brief: boardBriefInput.value.trim(),
        querySnapshot: currentBoardQuerySnapshot(),
        items: selectedIds.map((itemId) => ({ itemId, matchReasonsAtSave: candidates.get(itemId)?.matchReasonsAtSave || [] })),
      }),
    });
    setBoardDialogBusy();
    closeBoardModal({ restoreFocus: false });
    await openBoard(response.board.id);
    boardCloseButton?.focus();
    announceBoard("Board created.");
  } catch (error) {
    setBoardDialogStatus(error.message || "Could not save board.", "error");
  } finally {
    setBoardDialogBusy();
  }
};

const copyBoardExport = async ({ download = false } = {}) => {
  if (!boardState.active) return;
  try {
    const result = await boardRequest(`./api/boards/${encodeURIComponent(boardState.active.board.id)}/export?format=markdown`);
    if (download) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([result.content], { type: "text/markdown" }));
      link.download = "board.md";
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
      announceBoard("Board exported.");
      return;
    }
    await navigator.clipboard.writeText(result.content);
    announceBoard("Board copied.");
  } catch (error) {
    announceBoard(error.message || "Could not export board.");
  }
};

const initBoardFlow = () => {
  if (PUBLIC_DEMO) {
    if (boardCreateButton) boardCreateButton.hidden = true;
    if (boardModal) boardModal.hidden = true;
    return;
  }
  boardCreateButton?.addEventListener("click", () => { void openBoardModal(); });
  boardDialogClose?.addEventListener("click", () => closeBoardModal());
  boardCancel?.addEventListener("click", () => closeBoardModal());
  boardModal?.addEventListener("click", (event) => { if (event.target === boardModal) closeBoardModal(); });
  boardForm?.addEventListener("submit", (event) => { event.preventDefault(); void submitBoardForm(); });
  boardForm?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); closeBoardModal(); }
    if (event.key === "Tab") trapFocusWithin(event, boardForm);
  });
  boardEditButton?.addEventListener("click", () => { void openBoardModal({ edit: true }); });
  boardCloseButton?.addEventListener("click", exitBoardMode);
  boardCopyButton?.addEventListener("click", () => { void copyBoardExport(); });
  boardExportButton?.addEventListener("click", () => { void copyBoardExport({ download: true }); });
  boardCurationEdit?.addEventListener("click", () => {
    if (!currentBoardLightboxEntry()) return;
    boardState.curationTrigger = boardCurationEdit;
    boardCurationText.hidden = true;
    boardCurationEdit.hidden = true;
    boardCurationForm.hidden = false;
    boardCurationInput.focus();
  });
  boardCurationCancel?.addEventListener("click", () => {
    const trigger = boardState.curationTrigger || boardCurationEdit;
    renderBoardCuration();
    trigger?.focus();
    boardState.curationTrigger = null;
  });
  boardCurationForm?.addEventListener("submit", (event) => { event.preventDefault(); void updateBoardCuration(); });
  boardMoveEarlier?.addEventListener("click", () => { void mutateBoardOrder("earlier"); });
  boardMoveLater?.addEventListener("click", () => { void mutateBoardOrder("later"); });
  boardRemoveItem?.addEventListener("click", () => { void mutateBoardOrder("remove"); });
  window.addEventListener("popstate", () => {
    const search = window.location.search;
    const navigationGeneration = ++boardState.navigationGeneration;
    void BoardHistory.reconcileBoardHistory({
      search,
      activeBoardId: boardState.active?.board.id || "",
      openBoard,
      closeBoard: exitBoardMode,
      isCurrent: () => boardState.navigationGeneration === navigationGeneration && window.location.search === search,
    });
  });
};

const restoreBoardFromUrl = async () => {
  if (PUBLIC_DEMO) return;
  const id = new URLSearchParams(window.location.search).get("board");
  if (id) await openBoard(id, { replace: true });
};

// --- Init ---

const init = async () => {
  if (PUBLIC_DEMO) {
    document.documentElement.dataset.publicDemo = "true";
    if (clipAddButton) clipAddButton.hidden = true;
    if (boardCreateButton) boardCreateButton.hidden = true;
    if (manualNoteSection) manualNoteSection.hidden = true;
  }

  try {
    const { data, path } = await fetchJsonFromFirstAvailable([
      "./bookmarks-data.json",
      "./bookmarks-data.sample.json",
    ]);
    // Support both old format (array) and new format ({ folders, bookmarks })
    let folderCount = 0;
    if (Array.isArray(data)) {
      ALL_BOOKMARKS = data;
    } else {
      ALL_BOOKMARKS = data.bookmarks || [];
      folderCount = Array.isArray(data.folders) ? data.folders.length : 0;
    }
    ALL_BOOKMARKS = ALL_BOOKMARKS.map(decorateRuntimeBookmark);
    BOOKMARKS_WITH_IMAGES = ALL_BOOKMARKS.filter(
      (b) => b.images && b.images.length > 0
    );
    console.log(
      `Loaded ${BOOKMARKS_WITH_IMAGES.length} bookmarks with images, ${folderCount} folders from ${path}`
    );
  } catch (e) {
    console.error("Failed to load bookmarks data:", e);
    return;
  }

  try {
    const { data: mediaData, path: mediaPath } = await fetchJsonFromFirstAvailable([
      "./media-cards-clean.json",
      "./media-cards.sample.json",
    ]);
    MEDIA_CARDS = Array.isArray(mediaData.cards) ? mediaData.cards : [];
    MEDIA_INDEX_GENERATED_AT = mediaData.generatedAt || "";
    rebuildMediaCardIndex();
    console.log(`Loaded ${MEDIA_CARDS.length} media cards from ${mediaPath}`);
  } catch (e) {
    console.warn("Failed to load media card metadata:", e);
  }

  if (!PUBLIC_DEMO) {
    try {
      const notesRes = await fetch("./api/manual-notes", { cache: "no-store" });
      if (notesRes.ok) {
        const notesData = await notesRes.json();
        MANUAL_NOTES = notesData.notes && typeof notesData.notes === "object" ? notesData.notes : {};
        console.log(`Loaded ${Object.keys(MANUAL_NOTES).length} manual media notes`);
      }
    } catch (e) {
      console.warn("Manual notes are unavailable. Start the local server to save edits.", e);
    }
  }

  if (!PUBLIC_DEMO) {
    await refreshWebClips({ render: false, initial: true, force: true });
  }

  BOOKMARKS_WITH_IMAGES = ALL_BOOKMARKS.filter(
    (b) => b.images && b.images.length > 0
  );

  buildMasonryLayout();
  createPool();
  renderVisibleItems();
  createDesignTopbar();
  createAuthorFilterPill();
  initSearch();
  initClipFlow();
  initBoardFlow();
  setupWebClipRefresh();
  updateDebugHud();

  // Pre-warm Motion's animation engine so first lightbox open doesn't stutter
  const warmup = document.createElement("div");
  warmup.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;";
  document.body.appendChild(warmup);
  Motion.animate(warmup, { opacity: [0, 1] }, { duration: 0.01 }).then(() => warmup.remove());

  viewport.addEventListener("mousedown", onMouseDown);
  viewport.addEventListener("mousemove", onMouseMove);
  viewport.addEventListener("mouseup", onMouseUp);
  viewport.addEventListener("mouseleave", onMouseUp);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("touchstart", onTouchStart);
  viewport.addEventListener("touchmove", onTouchMove, { passive: false });
  viewport.addEventListener("touchend", onTouchEnd);
  window.addEventListener("resize", onWindowResize);

  lightboxClose.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  lightboxPrev.addEventListener("click", (e) => {
    e.stopPropagation();
    navigateLightbox(-1);
  });
  lightboxNext.addEventListener("click", (e) => {
    e.stopPropagation();
    navigateLightbox(1);
  });
  manualNoteEdit?.addEventListener("click", (e) => {
    e.stopPropagation();
    openManualNoteEditor();
  });
  manualNoteCancel?.addEventListener("click", (e) => {
    e.stopPropagation();
    cancelManualNoteEditor();
  });
  manualNoteForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void saveManualNote();
  });
  manualNoteInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancelManualNoteEditor();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.stopPropagation();
    }
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLightbox();
  });
  window.addEventListener("keydown", (e) => {
    if (e.shiftKey && e.key.toLowerCase() === "d" && !shouldIgnoreDebugShortcut(e.target)) {
      e.preventDefault();
      state.debugEnabled = !state.debugEnabled;
      updateDebugHud();
      return;
    }
    if (e.key === "Escape" && state.lightboxOpen) closeLightbox();
    if (e.key === "Escape" && boardState.active && !state.lightboxOpen && !boardModal?.hidden) {
      closeBoardModal();
    } else if (e.key === "Escape" && boardState.active && !state.lightboxOpen && boardModal?.hidden) {
      exitBoardMode();
    }
    if (e.key === "ArrowLeft" && state.lightboxOpen) navigateLightbox(-1);
    if (e.key === "ArrowRight" && state.lightboxOpen) navigateLightbox(1);
    if (e.key === "Tab" && state.lightboxOpen) trapLightboxFocus(e);
  });

  await restoreBoardFromUrl();

  animate();
};

init();
