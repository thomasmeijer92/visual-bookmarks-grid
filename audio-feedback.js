import {
  defineSound,
  ensureReady,
  setMasterVolume,
} from "./node_modules/@web-kits/audio/dist/index.js";

const params = new URLSearchParams(window.location.search);
const audioDisabled = params.get("audio") === "0";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const enabled = !audioDisabled && !reduceMotion;
const MASTER_VOLUME = 0.28;

const openSound = defineSound({
  source: { type: "triangle", frequency: { start: 220, end: 420 } },
  filter: { type: "lowpass", frequency: 1400 },
  envelope: { attack: 0.001, decay: 0.09, sustain: 0, release: 0.025 },
  gain: 0.09,
});

const closeSound = defineSound({
  source: { type: "sine", frequency: { start: 360, end: 180 } },
  filter: { type: "lowpass", frequency: 1100 },
  envelope: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.02 },
  gain: 0.07,
});

const tickSound = defineSound({
  source: { type: "noise", color: "pink" },
  filter: { type: "bandpass", frequency: 1800, resonance: 3 },
  envelope: { attack: 0.001, decay: 0.025, sustain: 0, release: 0.01 },
  gain: 0.035,
});

const typeSound = defineSound({
  source: { type: "sine", frequency: { start: 720, end: 520 } },
  filter: { type: "lowpass", frequency: 1800 },
  envelope: { attack: 0.001, decay: 0.018, sustain: 0, release: 0.006 },
  gain: 0.018,
});

const menuHoverSound = defineSound({
  source: { type: "triangle", frequency: { start: 520, end: 460 } },
  filter: { type: "lowpass", frequency: 1600 },
  envelope: { attack: 0.001, decay: 0.022, sustain: 0, release: 0.008 },
  gain: 0.02,
});

const selectSound = defineSound({
  layers: [
    {
      source: { type: "triangle", frequency: 460 },
      envelope: { attack: 0.001, decay: 0.035, sustain: 0, release: 0.01 },
      gain: 0.045,
    },
    {
      source: { type: "triangle", frequency: 620 },
      envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.012 },
      delay: 0.028,
      gain: 0.035,
    },
  ],
});

let readyPromise = null;

const readyAudio = async () => {
  if (!enabled) return false;
  if (!readyPromise) {
    readyPromise = ensureReady().then(() => {
      setMasterVolume(MASTER_VOLUME);
      return true;
    });
  }
  return readyPromise;
};

const play = async (sound, options) => {
  try {
    if (await readyAudio()) sound(options);
  } catch {
    readyPromise = null;
  }
};

let lastTypeSoundAt = 0;
let lastMenuHoverSoundAt = 0;

window.addEventListener("pointerdown", readyAudio, { once: true, capture: true });
window.addEventListener("keydown", readyAudio, { once: true, capture: true });

window.addEventListener("bookmark-grid:sound", (event) => {
  switch (event.detail?.name) {
    case "lightbox-open":
      play(openSound);
      break;
    case "lightbox-close":
      play(closeSound);
      break;
    case "lightbox-nav":
      play(tickSound);
      break;
    case "folder-open":
      play(tickSound);
      break;
    case "folder-select":
      play(selectSound);
      break;
    case "search-type": {
      const now = performance.now();
      if (now - lastTypeSoundAt < 45) break;
      lastTypeSoundAt = now;
      play(typeSound, {
        detune: (event.detail.length % 5) * 18,
        velocity: 0.55,
      });
      break;
    }
    case "menu-hover": {
      const now = performance.now();
      if (now - lastMenuHoverSoundAt < 70) break;
      lastMenuHoverSoundAt = now;
      play(menuHoverSound, {
        detune: (event.detail.index % 4) * 14,
        velocity: 0.5,
      });
      break;
    }
  }
});
