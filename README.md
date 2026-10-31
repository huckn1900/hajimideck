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
| Time Crisis 3 (2004) / L.A. Machineguns (1998) | not emulated here: no core in this tree covers System Ps2 / Model 2 | shown as locked cabinets |

Two boards are slower than realtime on a normal desktop CPU: that is the emulator, not the page.
Measured negatives: MAME's frameskip option and disabling sound do **not** raise the frame rate,
and this MAME build has no selectable 68k core, so there is no remaining performance lever. The
page keeps those cabinets honest instead of pretending — the audio output follows the machine's
own pace rather than holding a stuck tone.

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
serves the files as-is instead of running a Jekyll build over them.

## Credits and licence

MAME is GPL-2.0 (the compiled cores are built from MAME 0.289 source in the jamma checkout); the
browser audio backend in those cores is JSMAME, BSD-3-Clause. ROM images are Namco / Konami
copyrighted works, included here for play and research. The page and its artwork are original.
