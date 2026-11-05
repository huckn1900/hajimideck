// ../jamma/src/index.ts
var FRAME_MS = 1000 / 60;
function pace60(now = () => performance.now()) {
  let due = 0;
  return () => {
    const t = now();
    if (t < due - 2)
      return false;
    due = due && t - due < FRAME_MS ? due + FRAME_MS : t + FRAME_MS;
    return true;
  };
}
var ROM_DIR = "/roms";
var MUTE_REASON_UI = 2;
var booted = false;
async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok || (res.headers.get("content-type") ?? "").startsWith("text/html"))
    return null;
  return new Uint8Array(await res.arrayBuffer());
}
async function toBytes(src) {
  if (typeof src === "string") {
    const whole = await fetchBytes(src);
    if (whole)
      return whole;
    const parts = [];
    for (let i = 0;i < 16; i++) {
      const p = await fetchBytes(`${src}.p${i}`);
      if (!p)
        break;
      parts.push(p);
    }
    if (!parts.length)
      throw new Error(`jamma: ${src} -> not served`);
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let off = 0;
    for (const x of parts) {
      out.set(x, off);
      off += x.length;
    }
    return out;
  }
  if (src instanceof Uint8Array)
    return src;
  if (src instanceof Blob)
    return new Uint8Array(await src.arrayBuffer());
  return new Uint8Array(src);
}
async function boot(opts) {
  if (booted)
    throw new Error("jamma: a machine is already running on this page");
  booted = true;
  const roms = await Promise.all(Object.entries(opts.roms).map(async ([name, src]) => [name, await toBytes(src)]));
  const { width, height } = opts.resolution ?? { width: 640, height: 480 };
  opts.canvas.id = "canvas";
  const coreBase = new URL(opts.core, location.href);
  await new Promise((resolve, reject) => {
    window.Module = {
      canvas: opts.canvas,
      arguments: [
        opts.driver,
        "-rompath",
        ROM_DIR,
        "-window",
        "-resolution",
        `${width}x${height}`,
        "-video",
        "bgfx",
        "-nothrottle",
        ...opts.args ?? []
      ],
      locateFile: (path) => new URL(path, coreBase).href,
      print: opts.onStdout ?? ((s) => console.log(s)),
      printErr: opts.onStderr ?? ((s) => console.warn(s)),
      preRun: [
        () => {
          const fs = window.FS;
          fs.mkdirTree(ROM_DIR);
          for (const [name, bytes] of roms) {
            const path = `${ROM_DIR}/${name}`;
            fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
            fs.writeFile(path, bytes);
          }
        }
      ],
      onRuntimeInitialized: () => resolve(),
      onAbort: (what) => reject(new Error(`jamma: core aborted: ${String(what)}`))
    };
    const script = document.createElement("script");
    script.src = coreBase.href;
    script.onerror = () => reject(new Error(`jamma: failed to load ${coreBase.href}`));
    document.body.appendChild(script);
  });
  window.MainLoop.preMainLoop.push(pace60());
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement)
      window.dispatchEvent(new Event("resize"));
  });
  const resumeAudio = () => {
    const ctx = window.jsmame_web_audio?.get_context();
    if (ctx && ctx.state !== "running")
      ctx.resume();
  };
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(type, resumeAudio, true);
  }
  const cwrap = window.Module.cwrap;
  const bindings = {
    get_ui: cwrap("_ZN15running_machine17emscripten_get_uiEv", "number"),
    get_sound: cwrap("_ZN15running_machine20emscripten_get_soundEv", "number"),
    ui_set_show_fps: cwrap("_ZN15mame_ui_manager12set_show_fpsEb", null, ["number", "number"]),
    sound_manager_mute: cwrap("_ZN13sound_manager4muteEbh", null, ["number", "number", "number"]),
    soft_reset: cwrap("_ZN15running_machine21emscripten_soft_resetEv", null),
    hard_reset: cwrap("_ZN15running_machine21emscripten_hard_resetEv", null),
    save: cwrap("_ZN15running_machine15emscripten_saveEPKc", null, ["string"]),
    load: cwrap("_ZN15running_machine15emscripten_loadEPKc", null, ["string"]),
    exit: cwrap("_ZN15running_machine15emscripten_exitEv", null, [])
  };
  const js = () => bindings;
  return {
    driver: opts.driver,
    softReset: () => js().soft_reset(),
    hardReset: () => js().hard_reset(),
    saveState: (slot) => js().save(slot),
    loadState: (slot) => js().load(slot),
    setMuted: (muted) => js().sound_manager_mute(js().get_sound(), muted ? 1 : 0, MUTE_REASON_UI),
    setShowFps: (show) => js().ui_set_show_fps(js().get_ui(), show ? 1 : 0),
    toggleFullscreen: async () => {
      if (document.fullscreenElement)
        return document.exitFullscreen();
      opts.canvas.style.objectFit = "contain";
      await opts.canvas.requestFullscreen();
    },
    exit: () => js().exit()
  };
}
export {
  boot,
  pace60
};
