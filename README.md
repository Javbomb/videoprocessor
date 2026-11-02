# Projector Waveform

A phone app (installable web app / PWA) that puts a DaVinci Resolve-style **waveform monitor** on photos and videos of a projected image. You calibrate it to your projector's **peak white**, so you can see how much of the projector's dynamic range a picture is actually using.

It runs on iPhone and Android with no app store. Open the page and choose *Add to Home Screen*.

## What it does

- **Open** a photo or video from the gallery (or take one: the phone's picker offers the camera), or use **Live** for the camera feed.
- **Scopes:** RGB overlay (the default: R, G and B traces drawn on top of each other), RGB Parade, and Luma (Y′, Rec.709).
- **SDR or HDR:** the vertical axis always runs from **0 at the bottom to peak white at the top**. You enter the peak white in nits, with presets (SDR 48/100/150/200, HDR 600/1k/4k/10k) or any value up to 10,000.
  - **SDR:** gamma-encoded signal. The legend can be **IRE** (0–100), **nits** (placed through the SDR gamma), or **10-bit** codes (0–1023).
  - **HDR (PQ, SMPTE ST 2084):** a PQ-spaced axis like Resolve's HDR scopes, topped at the chosen peak. The legend can be **nits**, **% of peak** light, or **PQ code values** (e.g. 1,000 nits = 769).
  - **Stops:** for either signal type, a log scale of light below peak white.
- **Calibrate:** *Set white* on a shot of a 100% white frame. *Set black* on a 0% black frame (optional). After that, 1023 / 100% is the projector's peak white, and the stops scale shows the measured black floor as a dashed blue line. The app also reports the projector's contrast as the camera saw it. Calibration is saved on the phone.
- **Picture detection:** the projected picture is found automatically and **keystone-corrected**, because a photo never shows only the picture. The detector finds the outer lit raster, trims letterbox/pillarbox bars that appear on both opposite sides, and places each edge to sub-pixel accuracy. The raster found on the white calibration frame is remembered and reused for later shots, which is the most reliable mode. *Adjust corners* lets you drag the four corners, with a magnifier. *New files* can be set to Detect, Keep area (tripod) or Whole photo. *Picture shape* can force 16:9, 2.39:1 and so on.
- **Frame grabs / screenshots** (a digital frame rather than a photo of the screen) work too: letterbox or pillarbox bars are trimmed automatically. Clear the calibration to read the frame's own code values.
- **Scope look:** modelled on Resolve. The legend sits in a gutter with a ruler and minor ticks, and the stats sit in a strip above the plot, so nothing covers the trace. The plot is exactly as tall as the picture, and its columns line up with it. The trace is drawn like an analog waveform monitor (and Resolve): along each scan line, neighbouring pixels are joined by a continuous, sub-pixel anti-aliased stroke, so flat areas form thin bright lines and sharp edges show as faint vertical strokes. There is no blurring, and there is at least one source pixel per scope column (moving video is capped at 720 columns while playing; a paused frame re-renders in full). *Trace → Points* plots plain dots instead. Saves default to PNG, because browser JPEG encoding halves colour resolution and smears thin coloured traces. An optional **low-pass filter** (Off / Low / High, default Off; like the LPF option on Resolve's scopes and on hardware waveform monitors) removes camera noise and fine texture before plotting. As in Resolve, trace brightness follows sample *density*: stray samples stay dim and real tonal structure builds bright lines. The filter slightly softens extreme peaks, so set it to Off for exact peak readings.
- **Output:** save a new JPEG/PNG as **top/bottom**, **side-by-side**, **overlay** (scope over the image) or **scope only**. The scope is always as tall as the picture. Stats can be burned in. For videos and the live camera, **Record** makes a new video with the scope composed in.
- **Stats:** peak and floor, **APL** (average picture level: the mean signal, in IRE for SDR), **ADL** (average display level: the mean light on screen as % of peak white and in nits; the frame-average light level), stops of light used, camera clipping, and the share of the picture above reference white.
- **Sample photos:** *Try it with sample photos* calibrates on simulated white and black frames and opens a sunset scene. More samples are under Calibrate.
- `patterns.html` provides white, black, step, ramp, checkerboard and window test patterns to show on the projector.

## Getting accurate results

The scope measures what the camera recorded, so the photos matter:

1. **Lock the exposure** (iPhone: long-press to set AE/AF Lock. Android: Pro/Manual mode). Shoot the white frame and your content at the **same exposure**, and keep it there for the whole session.
2. Expose so the white frame is **not clipped**: it should be bright but under 255. The app warns you when the white sample is clipped.
3. Turn off HDR, Smart HDR and Night mode for photos, and turn off **HDR video** (iPhone: Settings → Camera → Record Video → HDR Video) for videos.
4. In SDR, set *SDR gamma* (Calibrate tab) to match the projector; 2.2 or 2.4 are typical. The IRE estimate inverts `L = black + (white − black) · signal^γ`. In HDR, the light measured relative to the calibrated white is scaled to the peak you enter (white patch = peak nits) and then PQ-encoded.
5. Phone cameras apply their own tone curve, so treat the readings as a good estimate rather than lab measurements. The *Stops* scale is the most robust view of "how much of the range is used".

Without calibration, the scope shows the photo's own code values, the same as running Resolve on the JPEG.

## Running it on your computer

There's no build step and nothing to install except [Node.js](https://nodejs.org) 18 or newer.

```
git clone <this repo>
cd projector-waveform
npm start
```

It prints two addresses:

- `http://localhost:8000` opens it on the computer. Drag and drop photos or videos onto the page.
- `http://<your-PC-IP>:8000` opens it on a phone on the same Wi-Fi, where **Open** browses the phone's gallery.

The **live camera** and *Add to Home Screen* need HTTPS on a phone (browsers only allow the camera on `https://` or `localhost`). For those, use the GitHub Pages build: the workflow in `.github/workflows/pages.yml` tests and publishes `main`. In the repo's Settings → Pages, set *Source* to **GitHub Actions**.

Tests: `npm test`

## Code

- `js/waveform.js` — transfer functions, calibration LUTs, waveform accumulation (with sub-code dithering so 8-bit sources don't band), statistics and scope rendering. Has no DOM dependencies, so it can be unit tested.
- `js/geometry.js` — picture detection, homography and perspective warp (no DOM; unit tested).
- `samples/generate.py` — renders the sample photos: procedural content projected through a simulated projector (gamma 2.4, ~2000:1, hotspot) onto a keystoned screen in a room, then "photographed" (glare, vignetting, noise, sRGB, JPEG). `--content your.jpg` simulates your own image on the screen.
- `js/app.js` — UI, gallery/video/camera sources, region picking, compositing, saving and recording.
- `serve.mjs` — zero-dependency local web server (`npm start`).
- `tests/` — `npm test`
