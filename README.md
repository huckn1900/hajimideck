# 哈基米 deck — Namco arcade cabinets in the browser

Seven arcade cabinets run in this page as WebAssembly (MAME 0.289 compiled with Emscripten, via
[jamma](https://github.com/b-rucel/jamma)). Open it, pick a cabinet, press 投币 then START.

Controls on a desktop: mouse = aim (light-gun games), left click = fire, right click = pedal,
wheel = weapon swap, Space = coin, 1 = start, S/F/E/D = stick. On a phone the pad appears under
the screen. No keyboard? The on-screen buttons do the same thing.

## What actually runs (measured, not assumed)

| Cabinet | Works | Note |
| --- | --- | --- |
| Tokyo Wars (1996) | playable, 60 fps, full simulation speed | joystick + light gun |
| Aqua Jet (1996) | playable, 60 fps, full simulation speed | joystick |
| Time Crisis (1995) | playable, ~57–60 fps | light gun, pedal |
| Time Crisis II (1998) | boots, plays at ~25% of real time | System 23 board; sound follows the machine's pace instead of cracking up |
| Crisis Zone (2001) | boots, plays at ~22% of real time | System 23 board, same |
| Silent Scope (1998) | boots only — the language MCU ROMs are BAD_DUMP, so no sound and no playable level | Konami/Hornet board |
| Silent Scope 2 (2001) | boots only, same reason | |
| Time Crisis 3 (2004) | not emulated here: System 246 needs a CHD disc image this pipeline has no support for, and its input ports are empty | shown as a locked cabinet |
| L.A. Machineguns (1998) | tried, does not run: a Model 3 core was built (mame/src/mame/sega/model3.cpp) and the ROMs verify, but the machine draws nothing — 47 s of black frames, MAME's own UI menu included — and the software polygon rasteriser runs at 7–15 fps in WASM. It has no light-gun port either (joystick + 4 buttons) | shown as a locked cabinet |
| Mario Kart Wii (2008) | playable, on a second engine: [wasm-dolphin](https://github.com/dougchansan/wasm-dolphin)'s WebAssembly port of Dolphin. Measured here: 60–73 core fps, 57–71 presented fps, 100–104% game speed, audio running with signal (RMS 0.16–0.21), title → menu → course → driver → race all render real content | console cabinet, GameCube pad; on GitHub Pages it is locked (see below) |

Two boards are slower than realtime on a normal desktop CPU: that is the emulator, not the page.
Measured negatives: MAME's frameskip option and disabling sound do **not** raise the frame rate,
and this MAME build has no selectable 68k core, so there is no remaining performance lever. The
page keeps those cabinets honest instead of pretending — the audio output follows the machine's
own pace rather than holding a stuck tone.

Wii cabinets do not come through the MAME pipeline: MAME 0.289 has no Wii driver and Wii ISOs are not
usable there. They come through [wasm-dolphin](https://github.com/dougchansan/wasm-dolphin) — upstream
Dolphin cross-compiled with Emscripten, its own PowerPC-to-WASM JIT, software rasterisation presented
through WebGPU. That engine is shipped in this site as the second engine, and it needs two browser
capabilities the page cannot force: WebGPU and SharedArrayBuffer, which require cross-origin isolation.
GitHub Pages cannot set response headers, so on Pages the console cabinet is locked; a server that can
send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
(`bun serve.ts` does) unlocks it. Its disc is not shipped here either — RMCE01 is a 2.59 GB image,
far over the site's budget — so an unlocked cabinet asks the player for a disc file. Measured on this
browser, only a real file from the player's disk mounts: a File built from fetched chunks is rejected
by the engine's worker, a file parked in OPFS exceeds Chrome's quota, and the engine reads the disc
without copying it into page memory.

## How it is served

Everything is static files, so this works on GitHub Pages with no server:

    roms/*.zip            the ROM sets (MAME unpacks them itself)
    jamma.js              the loader, transpiled from the jamma checkout at build time
    cores/<core>/<core>.js       Emscripten glue
    cores/<core>/<core>.wasm.gz  the wasm, gzip-compressed; the page decompresses it
                                 (Pages serves no Content-Encoding, so 6 MB instead of 30 MB)
    cores/<core>/<core>.wasm     the uncompressed wasm, kept so a browser without
                                 DecompressionStream still boots
    art/*.jpg            flyer and marquee scans; games without art get the generated poster
    cores/dolphin/       the second engine: Dolphin's WebAssembly core (js glue + wasm, uncompressed —
                         the engine fetches the wasm itself, there is no decompression entry point)
    dolphin/src/         that engine's host code; the audio worklet processor is loaded through
                         import.meta.url, so the directory ships with it
    dolphin/LICENSE      the engine's licence, kept in the site for attribution

Asset paths are page-relative so the whole thing works under a project-page path.
`status.json` is a static stand-in for the dev server's `/status.json`; the page only reads
`rompath` from it.

## Run it locally

    bun build-site.ts            # assemble ../hajimideck
    bun serve-site.ts            # Pages-shaped static server on :8091
    bun serve.ts --port 8090     # dev server (serves deck.html + the jamma checkout)

The dev server's `?res=`, `?skip=`, `?sr=`, `?gz=0`, `?glitch=0`, `?boot=<id>`, `?args=`
parameters are there for measurement, not for players.

## Publishing on GitHub Pages

This folder is the whole site — push it and turn Pages on, no build step there:

    git init && git add -A && git commit -m "hajimideck"
    git remote add origin https://github.com/<user>/hajimideck.git
    git branch -M main && git push -u origin main
    # then: repo Settings -> Pages -> Source: Deploy from a branch -> branch main, root

Pages caps a published site at 1 GB and warns around 100 GB/month of bandwidth; Git LFS does not
work with Pages, so the binaries are committed as plain files. `.nojekyll` is included so Pages
serves the files as-is instead of running a Jekyll build over them. Pages also cannot set response
headers, and a `<meta http-equiv>` does not stand in for them — so the capabilities the second
engine needs (cross-origin isolation, which SharedArrayBuffer and WebGPU require) cannot be granted
there. Hosting that can send headers (Netlify's `_headers`, Cloudflare's `_headers`) unlocks it.

## Credits and licence

MAME is GPL-2.0 (the compiled cores are built from MAME 0.289 source in the jamma checkout); the
browser audio backend in those cores is JSMAME, BSD-3-Clause. The console cabinet runs
[wasm-dolphin](https://github.com/dougchansan/wasm-dolphin), a WebAssembly port of Dolphin, which is
GPL-2.0-or-later like Dolphin itself; its licence is shipped at `dolphin/LICENSE` and its core is
built from that project's sources. ROM images and disc images are Namco / Konami / Nintendo
copyrighted works, included here for play and research. The page and its artwork are original.
