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
import { inputStateFromPressed, mergePressedSets, readGamepadInput, selectPreferredGamepad, WIIMOTE_BUTTON_BITS, WIIMOTE_IR } from "./input.js";

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
  // The Wii Remote's ⊕ and ⊖ keys. Measured on Arcade Hits: its ID-select and ranking-name screens
  // say 「Point and press ◎ or ⊕ to confirm」 — A and Start do nothing there; the confirm is the
  // Plus button, so a cabinet whose menus ask for aim has to be able to press it.
  KeyP: "PLUS", KeyM: "MINUS",
};

/**
 * Start a Wii/GameCube cabinet on the deck's canvas and return a deck-shaped machine.
 * `disc` must be a real disc file (a file input's File); an in-memory File of a whole
 * disc is rejected by the engine's WORKERFS reader.
 * `gun` turns the mouse into a Wii Remote pointer: the core builds a Wii Remote only
 * when the page asked for ?wiimote=1, so a cabinet without a lightgun never pays for it.
 */
export async function startDolphin({ canvas, disc, onStatus = () => {}, fullscreenTarget = null, gun = null }) {
  // Two things are done to the engine's status lines before they reach the cabinet:
  //  * the upstream core drives its own frame loop — its protocol answers mountFile, runFrame and
  //    setInputState but has no start/pause, so EmulatorHost's legacy lifecycle requests come back as
  //    "Unknown upstream worker message". Measured: the game runs at 64 core fps / 60 presented fps
  //    with that request unanswered, so it is engine-internal noise, not a cabinet message.
  //  * a refused disc is reported as "Dolphin adapter fallback: …" through onStatus only; the host
  //    swallows the error, so without keeping that line a cabinet can only say "adapter unavailable",
  //    which cannot be debugged.
  let mountFallback = "";
  const status = (msg) => {
    const text = String(msg);
    if (/Unknown upstream worker message: (start|pause)/.test(text)) return;
    if (/adapter fallback|adapter; demo core/.test(text)) mountFallback = text;
    onStatus(text);
  };
  const audio = new AudioController();
  const host = new EmulatorHost({ canvas, onFrame: () => {}, onStatus: status, onMode: () => {} });
  audio.setSource((frames) => host.mixAudio(frames));
  audio.setTransportBridge((config) => host.configureAudioWorklet(config));

  const game = await host.mountFile(disc);
  if (host.mode !== "dolphin") throw new Error(mountFallback || game.coreStatus || "dolphin adapter unavailable");

  host.start();

  // An AudioContext is only allowed to start after a user activation. Awaiting that here hangs a
  // cabinet opened from a restored URL forever — measured: the core mounted, the JIT warmed up, the
  // game ran, and the deck never received a machine, because setMuted(false) waits on context.resume()
  // which no click ever arrived to satisfy. So the request is issued without waiting, and every real
  // press re-issues it: Chrome resolves resume() once it sees an activation, and a one-shot request
  // made before the first press stays pending forever (measured: the graph stayed suspended through
  // a trusted key press, because nothing asked again).
  const armAudio = () => {
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
    // The dedup must cover the remote's button bits too: PLUS/MINUS are not GameCube pad
    // buttons, so a press of ⊕ changes no pad state at all — dedupping on the pad alone made
    // sendPointer unreachable from any key (measured on Arcade Hits' ranking-name screen: the
    // IR report never carried the plus bit while KeyP was held, and 「point and press ⊕」
    // screens stayed waiting forever).
    const key = JSON.stringify(state) + (gun ? "|" + irButtonBits() : "");
    if (key === lastSent) return;
    lastSent = key;
    host.setInputState?.(state);
    // A lightgun cabinet's remote needs the same press: the pad port is not wired to it, so a
    // key that the disc only understands as a remote button would otherwise never arrive.
    if (gun) sendPointer();
  };
  const onKeyDown = (e) => {
    // On a lightgun cabinet the deck's trigger key must reach the remote. A real pointerdown on the
    // canvas arrives through gunDown, but the deck's own paths (touch tap, gamepad A, ?deck API)
    // press the trigger as a key — without this branch the remote never fires (measured: Gunblade NY
    // took every aim screen dark while ControlLeft key events reached the window).
    if (gun && e.code === "ControlLeft") {
      if (e.isTrusted) armAudio();
      e.preventDefault();
      if (e.repeat) return;
      aiming.firing = true;
      sendPointer();
      return;
    }
    const b = DECK_KEYS[e.code];
    if (!b) return;
    // Only a press the player actually made counts as an activation for Chrome's autoplay policy;
    // events the deck synthesises (coin door, touch pad) do not, and asking for them would be noise.
    if (e.isTrusted) armAudio();
    e.preventDefault();
    if (e.repeat) return;
    pressed.add(b);
    sendState();
  };
  const onKeyUp = (e) => {
    // The trigger's key path needs its release too: without this, a deck trigger press left
    // the remote firing forever (measured on Arcade Hits — buttons=1024 and an IR pair stayed
    // in every report after ControlLeft keyup, so the ID-select screen kept seeing a held
    // Zapper shot and ignored the d-pad navigation).
    if (gun && e.code === "ControlLeft") {
      if (!aiming.firing) return;
      aiming.firing = false;
      sendPointer();
      return;
    }
    const b = DECK_KEYS[e.code];
    if (!b) return;
    pressed.delete(b);
    sendState();
  };
  // Mouse on the screen is a controller too: left = A (confirm / accelerate), right = B.
  // On a lightgun cabinet the left button is the remote's trigger instead — aiming is
  // what that cabinet is for, and pad A would double-fire the same click.
  // The engine may REPLACE the canvas DOM node with a fresh clone when it transfers control to its
  // worker (core-host's captureStream fallback). Measured on Cloudflare Pages: after that swap the
  // live #canvas held no listeners at all — a real mouse over the screen moved nothing, and the
  // remote reported its default aim forever. So screen input listens on window, which the events
  // bubble to either way, and hit-tests the element BY ID: the id survives the swap, the node
  // does not.
  const liveCanvas = () => document.getElementById(canvas.id) || canvas;
  const overCanvas = (e) => {
    const rect = liveCanvas().getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      e.clientX >= rect.left && e.clientX < rect.right && e.clientY >= rect.top && e.clientY < rect.bottom;
  };
  const pointerDown = (e) => {
    if (!overCanvas(e)) return;
    if (e.isTrusted) armAudio();   // tapping the screen is a real gesture: the speakers may start here
    if (gunDown(e)) return;
    pressed.add(e.button === 2 ? "B" : "A");
    sendState();
  };
  const pointerUp = () => {
    if (gunUp()) return;
    pressed.delete("A");
    pressed.delete("B");
    sendState();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointerdown", pointerDown);
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("blur", pointerUp);

  // ---- Wii Remote pointer (lightgun cabinets) ----
  // The core's IR camera is a 1024x768 field projected over the video output, so a
  // pointer over the cabinet maps proportionally; the game turns that into a crosshair.
  // Button bits follow WiimoteCommon::ButtonData, and the mask (~0x60e0) drops the bits
  // that carry accelerometer data in the same field.
  const IR_TRIGGER_BIT = WIIMOTE_BUTTON_BITS.b & WIIMOTE_IR.BUTTON_MASK;
  // On a lightgun cabinet the Wii Remote is the only controller the disc sees — the pad port is
  // not wired to a remote — so the deck's keys have to arrive as remote buttons. Bits are
  // WiimoteCommon::ButtonData's: A = 1<<11, B = 1<<10, 1 = Start, 2 = Select, d-pad = 1<<0..3.
  const IR_KEY_BITS = {
    A: WIIMOTE_BUTTON_BITS.a, B: WIIMOTE_BUTTON_BITS.b,
    START: WIIMOTE_BUTTON_BITS.one, SELECT: WIIMOTE_BUTTON_BITS.two,
    D_LEFT: WIIMOTE_BUTTON_BITS.left, D_RIGHT: WIIMOTE_BUTTON_BITS.right,
    D_UP: WIIMOTE_BUTTON_BITS.up, D_DOWN: WIIMOTE_BUTTON_BITS.down,
    PLUS: WIIMOTE_BUTTON_BITS.plus, MINUS: WIIMOTE_BUTTON_BITS.minus,
  };
  const irButtonBits = () => {
    let bits = aiming.firing ? IR_TRIGGER_BIT : 0;
    for (const key of pressed) bits |= IR_KEY_BITS[key] ?? 0;
    return bits & WIIMOTE_IR.BUTTON_MASK;
  };
  // Dolphin's own comment on point size: "small values (2-4) seem to be very typical".
  const IR_POINT_SIZE = 3;
  // Measured on Arcade Hits (l34/l35): with the bar blobs at size 12 the ID menu pinned its
  // crosshair and its shot-time hover stopped following the aim. With bar blobs at size 3 (l20/l23:
  // CAMDBG pts all size 3) the shot-sampled hover followed the aim directly and a held shot at a
  // highlighted card confirmed. The theory that big LED blobs help the game tell bar from target is
  // refuted by measurement — the game wants typical small blobs everywhere.
  const IR_LED_SIZE = IR_POINT_SIZE;
  // The sensor bar's LEDs sit on the TV, not on the aim. A real remote's camera always sees two
  // fixed LED clusters, and the game derives its crosshair from (target − the LEDs' virtual point).
  // The pair used to straddle the aim symmetrically, which put the virtual point ON the aim: the
  // cursor was always zero, wherever we pointed. Measured on Arcade Hits: the crosshair stayed
  // fixed at the panel centre through every aim, the ID-slot hover never followed the pointer, and
  // no letter on the ranking-name screen registered although ⊕/⊖ presses arrived with live points
  // (the screens answered plain buttons, which is why the menus advanced but aiming never did).
  // Real hardware reports the bar where the bar physically is, so the two clusters now sit at the
  // top edge of the camera field, far apart: every aim point inside the field is closer to one LED
  // than the LEDs are to each other, so a game that pairs the closest clusters still gets the bar,
  // and the third point is the aim itself.
  const IR_BAR_Y = 40;
  const IR_BAR_LEFT_X = 60;
  const IR_BAR_RIGHT_X = WIIMOTE_IR.CAMERA_RES_X - 60;
  const aiming = { irx: WIIMOTE_IR.CAMERA_RES_X / 2, iry: WIIMOTE_IR.CAMERA_RES_Y / 2, firing: false };
  // Some Wii arcade ports open with a two-player screen that only completes if a second remote is
  // answering: Gunblade NY's "Select the ID you would like to use. Player1 / Player2" panel waits for
  // both halves and, with one remote, cycles back to itself (measured through a 46s held-trigger run).
  // ?aim2=1 feeds the same aim and buttons into remote index 1 as well — a shared sight, enough to
  // complete the menu; the deck has one pointer, so the two players aim together.
  const aimPartners = (() => {
    try { return Number(new URLSearchParams(window.location.search).get("aim2")) > 0 ? [0, 1] : [0]; } catch { return [0]; }
  })();
  // Decode-shape layouts (measurement knob stays overridable via ?irshape=). Production default is
  // "baraimpair", measured on Arcade Hits through l7–l56: the ID-select menu's highlight follows the
  // shot-sampled aim with this layout and the ID confirm goes through (Saving screen reached 11/11);
  // the plain real-remote shape ("bar3") never produced a cursor at all, and a duplicated aim point
  // paired into a zero cursor. The game's IR decode order is not known from the disc, so
  // ?irshape still lets a live cabinet pick another point-slot layout:
  //   bar3     — LEDs slots 0/1, aim slot 2 (real-remote shape; measured: no cursor ever)
  //   baraimp  — LEDs slots 0/1, aim duplicated in slots 2/3 (target as a valid pair; cursor ≡ 0)
  //   aimfirst — aim pair slots 0/1, LEDs slots 2/3 (aim is the closest cluster in either decode)
  //   baraimpairb / barreal — bar-position variants (both refuted on the ranking-name screen)
  let irShape = (() => {
    try { return new URLSearchParams(window.location.search).get("irshape") || "baraimpair"; } catch { return "baraimpair"; }
  })();
  // Runtime measurement hooks: reaching the ranking-name screen drifts ±60s per boot, so a
  // per-shape boot cannot guarantee a decode-shape knob lands on the screen being tested.
  // The driver switches shape and aim-blob size live, mid-run, once the screen is confirmed.
  let aimSize = IR_POINT_SIZE;
  window.__setIrShape = (v) => { if (typeof v === "string") { irShape = v; sendPointer(); } };
  window.__setIrAimSize = (n) => {
    if (Number.isFinite(n)) { aimSize = Math.max(1, Math.min(15, Math.round(n))); sendPointer(); }
  };
  // The bar's position in the camera field is what a game's pointer decode keys on, not the aim:
  // measured on Arcade Hits, its ID menu drew a cursor that stayed pinned while the aim points moved,
  // so the decode reads the bar slots and turns their placement into a pointer. These knobs let a
  // driver scan where the bar is and fit the mapping, instead of guessing the bar's height.
  // The OEM bar spans 0.2 m between LED clusters; through a 42° IR camera at a normal remote
  // distance that projects to roughly 150-210 px of the 1024-wide field, not to the field's two
  // edges. Feeding edge-to-edge clusters is a geometry no real camera ever produces, and a game
  // that triangulates its pointer from the clusters gets a distorted result from it — which is what
  // the ID menu's mirrored-x / dropped-y decode looked like. These knobs let a driver fit the
  // cluster geometry against a screen that draws a cursor before anything ships.
  const IR_BAR_SEPARATION = IR_BAR_RIGHT_X - IR_BAR_LEFT_X;
  let barCx = (IR_BAR_LEFT_X + IR_BAR_RIGHT_X) / 2;
  let barY = IR_BAR_Y;
  let barSep = IR_BAR_SEPARATION;
  let ledSize = IR_LED_SIZE;
  window.__setIrBar = (cx, y) => {
    if (Number.isFinite(cx)) barCx = Math.min(WIIMOTE_IR.CAMERA_RES_X - 1, Math.max(0, Math.round(cx)));
    if (Number.isFinite(y)) barY = Math.min(WIIMOTE_IR.CAMERA_RES_Y - 1, Math.max(0, Math.round(y)));
    sendPointer();
  };
  window.__setIrBarSeparation = (px) => {
    if (Number.isFinite(px)) barSep = Math.max(4, Math.min(WIIMOTE_IR.CAMERA_RES_X - 2, Math.round(px)));
    sendPointer();
  };
  // The pointer's own two emitters: real hardware reports them as a small pair whose spacing the
  // game reads as distance, so the pair's spread is part of the geometry a title triangulates.
  let aimPairX = 22;
  let aimPairY = 10;
  window.__setIrAimPair = (dx, dy) => {
    if (Number.isFinite(dx)) aimPairX = Math.max(0, Math.min(200, Math.round(dx)));
    if (Number.isFinite(dy)) aimPairY = Math.max(0, Math.min(200, Math.round(dy)));
    sendPointer();
  };
  window.__setIrLedSize = (n) => {
    if (Number.isFinite(n)) { ledSize = Math.max(1, Math.min(15, Math.round(n))); sendPointer(); }
  };
  const sendPointer = () => {
    const buttons = irButtonBits();
    // A real remote never reports a single dot: its camera sees the sensor bar's two LED clusters,
    // and Wii titles that ask the player to aim at the screen treat a report whose second cluster is
    // missing as 「the Zapper is not pointing at the TV」. Measured: HOTD's Zapper tutorial looped back
    // to itself through eight presses while a one-point report was live, then created its save file
    // as soon as a shot went in — the screens that ask for aim are the ones that need the bar.
    // The bar is reported where the bar physically is (see IR_BAR_* above); the third point is the
    // aim, exactly where the pointer is.
    // The report streams ALWAYS, not only while the trigger is held. Measured on Arcade Hits: its
    // ID-select and ranking-name screens hover-highlight a target only while the IR camera keeps
    // reporting, and with trigger-gated points those screens never saw the pointer at all — the
    // highlight stayed on one slot through every aim, and no letter on the name screen ever
    // registered. Real hardware streams the camera continuously; a Zapper game samples it on the
    // trigger pull, and that sampling is what the trigger bit is for.
    const led = (x) => ({ x, y: barY, size: ledSize });
    const aim = () => ({ x: aiming.irx, y: aiming.iry, size: aimSize });
    const aimSplit = (dx, dy) => ({
      x: Math.min(WIIMOTE_IR.CAMERA_RES_X - 1, Math.max(0, aiming.irx + dx)),
      y: Math.min(WIIMOTE_IR.CAMERA_RES_Y - 1, Math.max(0, aiming.iry + dy)),
      size: aimSize,
    });
    // The default offsets are the measured baraimpair pair: both emitters share the vertical
    // offset, mirrored horizontally. Only the spread is a geometry choice; the midpoint is what a
    // title reads.
    const pair = () => [aimSplit(aimPairX, aimPairY), aimSplit(-aimPairX, aimPairY)];
    const barLeft = () => Math.max(0, barCx - barSep / 2);
    const barRight = () => Math.min(WIIMOTE_IR.CAMERA_RES_X - 1, barCx + barSep / 2);
    // baraimpairb: same as baraimpair but the LED clusters sit on the BOTTOM edge. Measurement
    // knob: the ranking-name screen never reacted to aim with the top bar while the ID menu did,
    // and its cursor stayed pinned — if the game assumes the bar is below the TV (the common Wii
    // install), aim above a bottom bar is the only report its validity test accepts.
    const ledBottom = (x) => ({ x, y: WIIMOTE_IR.CAMERA_RES_Y - 40, size: IR_LED_SIZE });
    const points = irShape === "aimfirst"
      ? [aim(), aim(), led(barLeft()), led(barRight())]
      : irShape === "baraimp"
        ? [led(barLeft()), led(barRight()), aim(), aim()]
      : irShape === "baraimpair"
        ? [led(barLeft()), led(barRight()), ...pair()]
          : irShape === "baraimpairb"
            ? [ledBottom(barLeft()), ledBottom(barRight()), aimSplit(22, -10), aimSplit(-22, -10)]
            // barreal: real sensor-bar geometry — the two LED clusters sit adjacent near the top
            // centre of the camera field (a physical bar spans a small fraction of the view, not
            // the screen edges). Measurement knob for the ranking-name screen, which rejected every
            // aim with edge-cluster bars while the ID menu accepted the same report: if its
            // validity test matches real LED spacing, this is the shape it accepts.
            : irShape === "barreal"
              ? [led(445), led(579), aimSplit(22, 10), aimSplit(-22, 10)]
              : [led(barLeft()), led(barRight()), aim()];
    for (const index of aimPartners) host.setWiimoteIR?.({ index, buttons, points });
  };
  const aimFromEvent = (e) => {
    const rect = liveCanvas().getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    aiming.irx = Math.min(WIIMOTE_IR.CAMERA_RES_X - 1, Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * WIIMOTE_IR.CAMERA_RES_X)));
    aiming.iry = Math.min(WIIMOTE_IR.CAMERA_RES_Y - 1, Math.max(0, Math.round(((e.clientY - rect.top) / rect.height) * WIIMOTE_IR.CAMERA_RES_Y)));
    sendPointer();
  };
  // A trigger held by a real pointer over the screen is released when the pointer leaves the
  // screen; a trigger held by a key (ControlLeft, the touch pad) must NOT be cleared by unrelated
  // pointer moves elsewhere on the page, so the two sources are tracked apart.
  let pointerFiring = false;
  const gunDown = (e) => {
    if (!gun || e.button !== 0) return false;
    aiming.firing = true;
    pointerFiring = true;
    aimFromEvent(e);
    return true;
  };
  const gunUp = () => {
    if (!gun || !aiming.firing) return false;
    aiming.firing = false;
    pointerFiring = false;
    sendPointer();
    return true;
  };
  const aimOff = () => {
    if (!gun || !aiming.firing || !pointerFiring) return;
    aiming.firing = false;
    pointerFiring = false;
    sendPointer();
  };
  const aimMove = (e) => { if (overCanvas(e)) aimFromEvent(e); else aimOff(); };
  if (gun) {
    window.addEventListener("pointermove", aimMove);
    sendPointer();
  }

  const poll = setInterval(sendState, 2);   // gamepad polling, as the upstream app does

  const stop = () => {
    clearInterval(poll);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("pointerdown", pointerDown);
    window.removeEventListener("pointerup", pointerUp);
    window.removeEventListener("blur", pointerUp);
    if (gun) {
      window.removeEventListener("pointermove", aimMove);
    }
    host.pause();
    // Leaving the cabinet also releases its engine: the worker holds the wasm instance and
    // its heap, so a re-boot has to not stack a second one beside the first.
    if (host.terminate) host.terminate();
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
    // Whether this cabinet aims through a Wii Remote, and what the core counted.
    // Asked on demand rather than polled: the worker round-trip should not run
    // every frame on cabinets nobody is aiming with.
    gunRequested: Boolean(gun),
    irStats: async () => (gun ? await (host.wiimoteStats?.() ?? { available: false }) : { available: false }),
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
