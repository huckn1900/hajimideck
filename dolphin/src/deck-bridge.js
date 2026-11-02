// Deck bridge for the second engine: Dolphin's WebAssembly port (wasm-dolphin).
//
// The deck speaks one machine API (boot() -> { softReset, saveState, ... }), so this module wraps
// EmulatorHost behind that same shape. Nothing here touches the deck's DOM ids: EmulatorHost needs a
// canvas plus callbacks, and the deck already owns its own canvas, coin door and HUD.
//
// What the engine needs from the page, measured rather than assumed:
//  * cross-origin isolation (SharedArrayBuffer drives the core's worker transport),
//  * WebGPU (the software framebuffer is presented through it),
//  * a disc handed over as a real file — an in-memory File of a 2.7 GB image fails inside
//    Emscripten's WORKERFS (Chromium's FileReaderSync rejects it), so the deck offers a file
//    picker when the disc is not something the browser can read from disk.

import { EmulatorHost } from "./core-host.js";
import { AudioController } from "./audio.js";
import { inputStateFromPressed, mergePressedSets, readGamepadInput, selectPreferredGamepad } from "./input.js";

// Static imports, not dynamic ones: these files are plain JS, and the engine itself (the 14.5 MB
// wasm) is only fetched when a disc is actually mounted.

// The configuration measured playable on Mario Kart Wii: software rasteriser, WebGPU presenter,
// dual CPU, the guarded WASM JIT after a warm-up, tick pacing. Read by the host from location.search,
// so the deck puts these on its own query before starting a Wii cabinet.
export const DOL_CONFIG = "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1";

export function dolphinEnv() {
  return {
    isolated: !!window.crossOriginIsolated,
    webgpu: !!navigator.gpu,
    sab: typeof SharedArrayBuffer !== "undefined",
  };
}

// Why the cabinet cannot be powered, in the deck's own words. Returns null when nothing blocks it.
export function dolphinBlockReason(env = dolphinEnv()) {
  const missing = [];
  if (!env.sab) missing.push("SharedArrayBuffer");
  if (!env.isolated) missing.push("cross-origin isolation (COOP/COEP)");
  if (!env.webgpu) missing.push("WebGPU");
  if (missing.length) return `引擎需要 ${missing.join(" + ")}，这个页面拿不到`;
  return null;
}

// Keys as the deck names them, mapped to Dolphin's GameCube pad buttons. Mario Kart Wii takes a
// GameCube controller, so this is the console's own input model, not a MAME port translation.
const DECK_KEYS = {
  KeyX: "A", KeyZ: "B", KeyV: "X", KeyB: "Y",
  Enter: "START", Digit1: "START", Digit2: "SELECT", Space: "START",
  ArrowLeft: "D_LEFT", ArrowRight: "D_RIGHT", ArrowUp: "D_UP", ArrowDown: "D_DOWN",
  KeyA: "STICK_LEFT", KeyD: "STICK_RIGHT", KeyW: "STICK_UP", KeyS: "STICK_DOWN",
  KeyQ: "L", KeyE: "R", KeyU: "C_STICK_UP", KeyJ: "C_STICK_DOWN", KeyH: "C_STICK_LEFT", KeyK: "C_STICK_RIGHT",
};

/**
 * Start a Wii/GameCube cabinet on the deck's canvas and return a deck-shaped machine.
 * `disc` must be a real disc file (a file input's File); an in-memory File of a whole
 * disc is rejected by the engine's WORKERFS reader.
 */
export async function startDolphin({ canvas, disc, onStatus = () => {}, fullscreenTarget = null }) {
  const audio = new AudioController();
  const host = new EmulatorHost({ canvas, onFrame: () => {}, onStatus, onMode: () => {} });
  audio.setSource((frames) => host.mixAudio(frames));
  audio.setTransportBridge((config) => host.configureAudioWorklet(config));

  const game = await host.mountFile(disc);
  if (host.mode !== "dolphin") throw new Error(game.coreStatus || "dolphin adapter unavailable");

  host.start();

  // An AudioContext is only allowed to start after a user activation. Awaiting that here hangs a
  // cabinet opened from a restored URL forever — measured: the core mounted, the JIT warmed up, the
  // game ran, and the deck never received a machine, because setMuted(false) waits on context.resume()
  // which no click ever arrived to satisfy. So the request is issued without waiting, and re-issued on
  // the first key or tap the player actually makes (Chrome then resolves the pending resume).
  let audioArmed = false;
  const armAudio = () => {
    if (audioArmed) return;
    audioArmed = true;
    host.setAudioMuted(false);
    void audio.setMuted(false).catch(() => {});
  };
  armAudio();

  // ---- input ----
  // Synthesised KeyboardEvents (the deck's coin/start/touchpad plumbing) and real presses both land
  // on window, so one listener feeds both. The adapter assigns the input generation itself.
  const pressed = new Set();
  let lastSent = "";
  const sendState = () => {
    const gp = selectPreferredGamepad(navigator.getGamepads?.() ?? []);
    const pad = gp ? readGamepadInput(gp) : { pressed: new Set(), state: null };
    const all = mergePressedSets(pressed, pad.pressed);
    const state = inputStateFromPressed(all, pad.state);
    const key = JSON.stringify(state);
    if (key === lastSent) return;
    lastSent = key;
    host.setInputState?.(state);
  };
  const onKeyDown = (e) => {
    const b = DECK_KEYS[e.code];
    if (!b) return;
    e.preventDefault();
    if (e.repeat) return;
    pressed.add(b);
    sendState();
  };
  const onKeyUp = (e) => {
    const b = DECK_KEYS[e.code];
    if (!b) return;
    pressed.delete(b);
    sendState();
  };
  // Mouse on the screen is a controller too: left = A (confirm / accelerate), right = B.
  const pointerDown = (e) => {
    pressed.add(e.button === 2 ? "B" : "A");
    sendState();
  };
  const pointerUp = () => { pressed.delete("A"); pressed.delete("B"); sendState(); };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("pointerdown", pointerDown);
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("blur", pointerUp);
  const poll = setInterval(sendState, 2);   // gamepad polling, as the upstream app does

  const stop = () => {
    clearInterval(poll);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("pointerdown", pointerDown);
    window.removeEventListener("pointerup", pointerUp);
    window.removeEventListener("blur", pointerUp);
    host.pause();
    audio.setMuted(true);
  };

  return {
    engine: "dolphin",
    driver: game.gameId ?? disc.name,
    game,
    stats: () => ({
      coreFps: host.coreFps,
      presentationFps: host.presentationFps,
      visibleChangeFps: host.visibleChangeFps,
      gameSpeed: host.gameSpeed,
      mode: host.mode,
      running: host.running,
      gameId: game.gameId ?? null,
      core: host.adapterLabel ?? null,
      videoBackend: host.videoBackend,
      presenter: host.presenterBackend ?? null,
      audio: audio.stats,
      transport: audio.activeTransport,
      audioFallback: audio.transportFallbackReason,
      // Whether the graph is actually allowed to run yet: suspended means the browser is still waiting
      // for a real user activation. Reporting it keeps the cabinet honest about its speakers.
      audioState: audio.context?.state ?? "none",
    }),
    // The deck's audio wrapper instruments MAME only. A console's own graph is exposed so the
    // honest question — is there signal on this cabinet's speakers? — can be measured from outside.
    audioController: audio,
    saveState: () => host.saveState(),
    loadState: () => host.loadState(),
    hardReset: () => host.reset(),
    softReset: () => host.reset(),
    setMuted: (m) => { audio.setMuted(m); host.setAudioMuted(m); },
    setShowFps: () => {},       // the deck's HUD shows the engine's own counters
    toggleFullscreen: () => fullscreenTarget?.requestFullscreen?.(),
    exit: stop,
  };
}
