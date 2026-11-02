import { FULL_QUAD, rectToQuad, isAxisAligned, quadBounds, quadAspect, warpQuad, detectPicture } from './geometry.js';
import { buildLUTs, computeWaveform, drawScope, scopePadding, denoiseRGBA, statsLines, formatStats, measureRegion, axisFor, fmtNits, LUMA, TRANSFERS } from './waveform.js';

// ---------------------------------------------------------------------------
// Persistent state
// ---------------------------------------------------------------------------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('wfm.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem('wfm.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const DEFAULTS = {
  mode: 'overlay', format: 'sdr', scale: 'percent', sdrPeak: 100, hdrPeak: 1000, stopsRange: 12, gain: 1.5,
  cameraTF: 'srgb', displayTF: 'g24', perChannel: true,
  layout: 'stacked', burnStats: true, denoise: true, fileFormat: 'jpeg', cropOnLoad: 'detect', aspect: 'auto',
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
if (settings.format !== 'sdr' && settings.format !== 'hdr') settings.format = 'sdr'; // older versions stored the file type here
let calibration = store.get('calibration', { white: null, black: null });
if (settings.keepCrop !== undefined) { // migrate from v1
  if (settings.keepCrop) settings.cropOnLoad = 'keep';
  delete settings.keepCrop;
}
// Picture area: normalized quad [TL, TR, BR, BL] in photo coordinates, or null = whole photo.
let crop = settings.cropOnLoad === 'full' ? null : migrateCrop(store.get('crop', null));
function migrateCrop(c) {
  if (!c) return null;
  if (Array.isArray(c) && c.length === 4) return c;
  if (typeof c.x === 'number') return rectToQuad(c);
  return null;
}
function setCrop(q) {
  crop = q;
  store.set('crop', q);
  pictureCache.key = '';
}
let luts = rebuildLUTs();

let source = null; // {kind: 'image'|'video'|'camera', el, w, h, name}
let stream = null;
let pick = null; // {kind, bitmap, w, h, rect | quad, drag, corner}
const pictureCache = { key: '', canvas: null };
let sourceId = 0;
let recorder = null;
let looping = false;
let renderQueued = false;
let lastStats = null;
let exposureLocked = false;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const view = $('view');
const stage = $('stage');
const video = $('video');
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true });

// ---------------------------------------------------------------------------
// Layout + render
// ---------------------------------------------------------------------------

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

const measureCtx = document.createElement('canvas').getContext('2d');

/** Gutter / strips around the scope plot for its legend, stats and caption. */
function scopePads(W, ih) {
  const plotW = settings.mode === 'parade' ? W : W; // legend sits left of the whole plot
  return scopePadding(measureCtx, plotW, ih, axisFor(settings.format, settings.scale), settings.scale, {
    peakNits: peakNits(), displayTF: settings.displayTF, stopsRange: Number(settings.stopsRange), stats: settings.burnStats,
  });
}

// The scope plot is always exactly as tall (and, except side-by-side, as wide and
// aligned with) the picture; the legend lives in margins around it.
function layoutDims(W, aspect) {
  W = even(W);
  const ih = even(W * aspect);
  const p = scopePads(W, ih);
  const { left: L, top: T, bottom: B, right: R } = p;
  switch (settings.layout) {
    case 'side':
      return { cw: W + L + W + R, ch: T + ih + B, img: { x: 0, y: T, w: W, h: ih }, scope: { x: W + L, y: T, w: W, h: ih }, pad: p };
    case 'overlay':
      return { cw: L + W + R, ch: T + ih + B, img: { x: L, y: T, w: W, h: ih }, scope: { x: L, y: T, w: W, h: ih }, overlay: true, pad: p };
    case 'scope':
      return { cw: L + W + R, ch: T + ih + B, img: null, scope: { x: L, y: T, w: W, h: ih }, pad: p };
    default:
      return { cw: L + W + R, ch: ih + T + ih + B, img: { x: L, y: 0, w: W, h: ih }, scope: { x: L, y: ih + T, w: W, h: ih }, pad: p };
  }
}

const ASPECTS = { '16:9': 16 / 9, '1.85': 1.85, '2.39': 2.39, '4:3': 4 / 3, '3:2': 1.5 };

/** Picture geometry in source pixels: quad, natural size and the output aspect (h / w). */
function pictureGeom(frameW, frameH) {
  const q = (crop || FULL_QUAD).map(([x, y]) => [x * frameW, y * frameH]);
  const warp = !!crop && !isAxisAligned(crop);
  const b = quadBounds(q);
  const natW = warp ? (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2 : b.w;
  const wOverH = ASPECTS[settings.aspect] || (warp ? quadAspect(q) : b.w / b.h);
  return { q, warp, bounds: b, natW: Math.max(1, natW), aspect: 1 / wOverH };
}

/**
 * The picture as something drawImage() can take, plus the source rect to use.
 * Perspective crops are rectified into a canvas of width `outW` (cached for stills).
 */
function getPicture(frame, frameW, frameH, outW) {
  const g = pictureGeom(frameW, frameH);
  if (!g.warp) return { el: frame, sx: g.bounds.x, sy: g.bounds.y, sw: g.bounds.w, sh: g.bounds.h, aspect: g.aspect, natW: g.natW };
  const dw = Math.max(16, Math.round(Math.min(outW, g.natW * 1.25)));
  const dh = Math.max(16, Math.round(dw * g.aspect));
  const still = source && source.kind === 'image' && frame === source.el;
  const key = still ? `${sourceId}|${JSON.stringify(crop)}|${dw}x${dh}` : '';
  if (still && pictureCache.key === key) return { el: pictureCache.canvas, sx: 0, sy: 0, sw: dw, sh: dh, aspect: g.aspect, natW: g.natW };

  // Read the quad's bounding box at about the output resolution, then warp it.
  const b = g.bounds;
  const s = Math.min(1, (1.3 * dw) / Math.max(1, b.w));
  const tw = Math.max(2, Math.round(b.w * s)), th = Math.max(2, Math.round(b.h * s));
  const tmp = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(frame, b.x, b.y, b.w, b.h, 0, 0, tw, th);
  const src = tctx.getImageData(0, 0, tw, th).data;
  const qt = g.q.map(([x, y]) => [((x - b.x) * tw) / b.w, ((y - b.y) * th) / b.h]);
  const out = (still ? null : pictureCache.live) || document.createElement('canvas');
  if (out.width !== dw) out.width = dw;
  if (out.height !== dh) out.height = dh;
  const octx = out.getContext('2d');
  const img = octx.createImageData(dw, dh);
  warpQuad(src, tw, th, qt, img.data, dw, dh);
  octx.putImageData(img, 0, 0);
  if (still) { pictureCache.key = key; pictureCache.canvas = out; } else pictureCache.live = out;
  return { el: out, sx: 0, sy: 0, sw: dw, sh: dh, aspect: g.aspect, natW: g.natW };
}

/** Render the composite of `frame` into `canvas` with image width W. Returns stats. */
function renderComposite(canvas, frame, frameW, frameH, W, analysisMax) {
  const pic = getPicture(frame, frameW, frameH, Math.max(W, analysisMax));
  const aspect = pic.aspect;
  const d = layoutDims(W, aspect);
  if (canvas.width !== d.cw) canvas.width = d.cw;
  if (canvas.height !== d.ch) canvas.height = d.ch;
  const ctx = canvas.getContext('2d');

  // Analysis pass on a down-scaled copy of the picture.
  let aw = Math.min(pic.natW, analysisMax);
  let ah = aw * aspect;
  if (ah > analysisMax) { ah = analysisMax; aw = ah / aspect; }
  aw = Math.max(8, Math.round(aw));
  ah = Math.max(8, Math.round(ah));
  if (work.width !== aw) work.width = aw;
  if (work.height !== ah) work.height = ah;
  workCtx.imageSmoothingQuality = 'medium';
  workCtx.drawImage(pic.el, pic.sx, pic.sy, pic.sw, pic.sh, 0, 0, aw, ah);
  const data = workCtx.getImageData(0, 0, aw, ah).data;
  if (settings.denoise) denoiseRGBA(data, aw, ah);

  const panelW = settings.mode === 'parade' ? d.scope.w / 3 : d.scope.w;
  const wf = computeWaveform(data, aw, ah, {
    mode: settings.mode,
    axis: axisFor(settings.format, settings.scale),
    columns: Math.min(Math.round(panelW), aw),
    rows: d.scope.h,
    luts,
    stopsRange: Number(settings.stopsRange),
  });

  ctx.fillStyle = '#0b0d0e';
  ctx.fillRect(0, 0, d.cw, d.ch);
  if (d.img) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pic.el, pic.sx, pic.sy, pic.sw, pic.sh, d.img.x, d.img.y, d.img.w, d.img.h);
  }
  drawScope(ctx, wf, d.scope.x, d.scope.y, d.scope.w, d.scope.h, {
    gain: Number(settings.gain),
    background: d.overlay ? 'rgba(0,0,0,0.42)' : '#050606',
    pad: d.pad,
    blackLight: luts.blackLight,
    unit: settings.scale,
    format: settings.format,
    peakNits: peakNits(),
    displayTF: settings.displayTF,
    caption: scopeCaption(),
    statsText: settings.burnStats ? statsLines(wf.stats, statsOpts()) : '',
  });
  return wf.stats;
}

/** Size the preview to the stage: full width, but never taller than ~70% of the viewport. */
function fitCanvasCSS(ratio) {
  const stageW = stage.clientWidth;
  const maxH = Math.max(240, window.innerHeight * (window.innerWidth >= 900 ? 0.86 : 0.7));
  const cssW = Math.min(stageW, maxH / ratio);
  view.style.width = cssW + 'px';
  view.style.height = cssW * ratio + 'px';
  view.style.margin = '0 auto';
  return cssW;
}

function previewW(aspect) {
  if (recorder) return Math.min(1280, Math.max(640, source.w));
  const probe = layoutDims(1000, aspect);
  const cssW = fitCanvasCSS(probe.ch / probe.cw);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.min(cssW * dpr, 1800); // total canvas pixel width
  return (px * 1000) / probe.cw;
}

function render() {
  renderQueued = false;
  if (pick) return renderPick();
  if (!source || !source.w) return;
  const aspect = pictureGeom(source.w, source.h).aspect;
  const W = previewW(aspect);
  if (recorder) {
    const d = layoutDims(W, aspect);
    fitCanvasCSS(d.ch / d.cw);
  }
  const analysis = source.kind === 'image' ? 1280 : 640;
  try {
    lastStats = renderComposite(view, source.el, source.w, source.h, W, analysis);
    showStats(lastStats);
  } catch (err) {
    console.error(err);
  }
}

function requestRender() {
  if (renderQueued || looping) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function startLoop() {
  if (looping) return;
  looping = true;
  const step = () => {
    if (!looping) return;
    render();
    const running = source && (source.kind === 'camera' || (source.kind === 'video' && !video.paused && !video.ended));
    if (!running || pick) { looping = false; return; }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  };
  step();
}

// ---------------------------------------------------------------------------
// Stats + calibration display
// ---------------------------------------------------------------------------

function showStats(s) {
  const f = formatStats(s, statsOpts());
  const parts = [
    `<b>Peak</b> ${f.peak}`,
    `<b>Floor</b> ${f.floor}`,
  ];
  if (f.apl) parts.push(`<b title="Average picture level: mean signal">APL</b> ${f.apl}`);
  parts.push(`<b title="Average display level: mean light on screen, relative to peak white">ADL</b> ${f.adl}`);
  parts.push(`<b>Range</b> ${s.rangeStops.toFixed(1)} stops`);
  if (luts.calibrated) parts.push(`<b>Peak</b> ${s.peakStops.toFixed(1)} st from white`);
  else parts.push('<span class="warn">not calibrated</span>');
  if (s.clipped > 0.002) parts.push(`<span class="warn">camera clipped ${(s.clipped * 100).toFixed(1)}%</span>`);
  if (luts.calibrated && s.overWhite > 0.002) parts.push(`<span class="warn">${(s.overWhite * 100).toFixed(1)}% above ref white</span>`);
  $('stats').innerHTML = parts.join(' · ');
}

function showCalibration() {
  const row = (name, ref) => {
    if (!ref) return `<dt>${name}</dt><dd>not set</dd>`;
    const [r, g, b] = ref.codeMean.map((v) => Math.round(v));
    const clip = ref.clipped > 0.005 ? ` · <span class="warn">${(ref.clipped * 100).toFixed(1)}% clipped</span>` : '';
    return `<dt>${name}</dt><dd><span class="swatch" style="background:rgb(${r},${g},${b})"></span>RGB ${r} / ${g} / ${b}${clip}</dd>`;
  };
  let html = row('White', calibration.white) + row('Black', calibration.black);
  if (calibration.white && calibration.black) {
    const m = (ref) => {
      const v = ref.means[settings.cameraTF] || ref.means.srgb;
      return LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
    };
    const cr = m(calibration.white) / Math.max(m(calibration.black), 1e-6);
    html += `<dt>Contrast</dt><dd>${Math.round(cr).toLocaleString()}:1 (${Math.log2(cr).toFixed(1)} stops, as seen by the camera)</dd>`;
  }
  $('calStatus').innerHTML = `<dl class="calstatus" style="display:contents">${html}</dl>`;
}

function peakNits() {
  const v = Number(settings.format === 'hdr' ? settings.hdrPeak : settings.sdrPeak);
  return Math.min(10000, Math.max(1, v || (settings.format === 'hdr' ? 1000 : 100)));
}

function statsOpts() {
  return { format: settings.format, unit: settings.scale, peakNits: peakNits(), calibrated: luts.calibrated };
}

function scopeCaption() {
  const peak = `${fmtNits(peakNits())} nits peak`;
  if (settings.format === 'hdr') return `HDR PQ · ${peak}`;
  const g = (TRANSFERS[settings.displayTF]?.label || '').replace(/ \(.*\)/, '').replace('Gamma ', 'γ');
  return `SDR ${g} · ${peak}`;
}

const PEAK_PRESETS = { sdr: [48, 100, 150, 200], hdr: [600, 1000, 4000, 10000] };

function rebuildLUTs() {
  return buildLUTs({
    peakNits: peakNits(),
    cameraTF: settings.cameraTF,
    displayTF: settings.displayTF,
    perChannel: settings.perChannel,
    white: calibration.white,
    black: calibration.black,
  });
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function setSource(src) {
  if (source && source.kind === 'image' && source.url) URL.revokeObjectURL(source.url);
  source = src;
  sourceId++;
  pictureCache.key = '';
  if (settings.cropOnLoad === 'full') setCrop(null);
  $('empty').hidden = !!src;
  $('saveBtn').disabled = !src;
  $('setWhite').disabled = !src;
  $('setBlack').disabled = !src;
  $('setCrop').disabled = !src;
  $('detectCrop').disabled = !src;
  const moving = src && (src.kind === 'video' || src.kind === 'camera');
  $('recordBtn').hidden = !moving || typeof MediaRecorder === 'undefined';
  $('videoBar').hidden = !src || src.kind !== 'video';
  $('camControls').hidden = !src || src.kind !== 'camera';
  $('cameraBtn').classList.toggle('primary', !!src && src.kind === 'camera');
  if (src && src.kind === 'image' && settings.cropOnLoad === 'detect') autoDetect(src.el, src.w, src.h, true);
  if (moving) startLoop();
  else requestRender();
}

// ---------------------------------------------------------------------------
// Picture-area detection
// ---------------------------------------------------------------------------

/** Run edge detection on a frame. Returns the detection result (normalized quads) or null. */
function detectOn(frame, fw, fh, useRaster = true) {
  const w = 512, h = Math.max(16, Math.round((512 * fh) / fw));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingQuality = 'medium';
  cx.drawImage(frame, 0, 0, fw, fh, 0, 0, w, h);
  const raster = useRaster && calibration.raster && calibration.rasterSize === `${fw}x${fh}` ? calibration.raster : null;
  return detectPicture(cx.getImageData(0, 0, w, h).data, w, h, raster ? { raster } : {});
}

/** Detect the picture on a frame and use it, keeping the previous area if detection is unsure. */
function autoDetect(frame, fw, fh, quiet = false) {
  let r = null;
  try { r = detectOn(frame, fw, fh); } catch (err) { console.error(err); }
  if (r && r.ok) {
    setCrop(r.quad);
    if (r.frame && luts.calibrated) {
      toast('This looks like a frame grab, not a photo of the screen. Clear the calibration (Calibrate → Clear) to read its own code values.', 7000);
    } else if (!quiet) {
      toast(r.trimmed ? 'Picture found (black bars excluded)' : 'Picture edges found');
    }
    return true;
  }
  if (!quiet || !crop) {
    toast(crop ? 'Couldn’t find the picture edges clearly; kept the previous area.'
      : 'Couldn’t find the picture edges. Use Crop → Adjust, or detect on the white frame.', 5000);
  }
  return false;
}

function stopVideo() {
  looping = false;
  video.pause();
  if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  video.srcObject = null;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  exposureLocked = false;
  $('lockExp').textContent = 'Lock exposure & WB';
}

async function openFile(file) {
  if (!file) return;
  if (recorder) stopRecording();
  cancelPick();
  stopVideo();
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name);
  try {
    if (isVideo) await loadVideo(file);
    else await loadImage(file);
  } catch (err) {
    console.error(err);
    toast(`Couldn't open ${file.name}. ${isVideo ? 'This video format may not be supported by the browser.' : 'Try a JPEG or PNG (HEIC is not supported everywhere).'}`);
  }
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  let el = img, w = img.naturalWidth, h = img.naturalHeight;
  const MAX = 4096;
  if (Math.max(w, h) > MAX) {
    const s = MAX / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, c.width, c.height);
    el = c; w = c.width; h = c.height;
    URL.revokeObjectURL(url);
    setSource({ kind: 'image', el, w, h, name: baseName(file.name) });
  } else {
    setSource({ kind: 'image', el, w, h, name: baseName(file.name), url });
  }
}

function loadVideo(file) {
  return new Promise((resolve, reject) => {
    video.srcObject = null;
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.onloadedmetadata = () => {
      video.onloadedmetadata = null;
      setSource({ kind: 'video', el: video, w: video.videoWidth, h: video.videoHeight, name: baseName(file.name) });
      if (settings.cropOnLoad === 'detect') {
        video.addEventListener('seeked', () => { autoDetect(video, video.videoWidth, video.videoHeight, true); requestRender(); }, { once: true });
      }
      video.currentTime = Math.min(0.05, video.duration || 0);
      updatePlayUI();
      resolve();
    };
    video.onerror = () => reject(video.error || new Error('video error'));
    video.load();
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Live camera needs HTTPS and a browser with camera access.');
    return;
  }
  if (source?.kind === 'camera') {
    // Toggle off
    if (recorder) stopRecording();
    cancelPick();
    stopVideo();
    setSource(null);
    $('stats').textContent = '';
    return;
  }
  if (recorder) stopRecording();
  cancelPick();
  stopVideo();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    toast('Camera unavailable: ' + (err.message || err.name));
    return;
  }
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => {});
  await new Promise((r) => (video.videoWidth ? r() : (video.onloadedmetadata = r)));
  setSource({ kind: 'camera', el: video, w: video.videoWidth, h: video.videoHeight, name: 'live' });
  setupCameraControls();
}

function setupCameraControls() {
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities ? track.getCapabilities() : {};
  const ev = caps.exposureCompensation;
  $('evField').hidden = !ev;
  if (ev) {
    const el = $('ev');
    el.min = ev.min; el.max = ev.max; el.step = ev.step || 0.1;
    el.value = track.getSettings().exposureCompensation ?? 0;
  }
}

async function toggleExposureLock() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const cur = track.getSettings ? track.getSettings() : {};
  const adv = {};
  const mode = exposureLocked ? 'continuous' : 'manual';
  if (caps.exposureMode?.includes(mode)) {
    adv.exposureMode = mode;
    if (mode === 'manual' && cur.exposureTime) adv.exposureTime = cur.exposureTime;
  }
  if (caps.whiteBalanceMode?.includes(mode)) {
    adv.whiteBalanceMode = mode;
    if (mode === 'manual' && cur.colorTemperature) adv.colorTemperature = cur.colorTemperature;
  }
  if (!Object.keys(adv).length) {
    toast('This browser can’t lock the camera. Use the phone camera app with AE/AF lock instead, then open the shots here.');
    return;
  }
  try {
    await track.applyConstraints({ advanced: [adv] });
    exposureLocked = !exposureLocked;
    $('lockExp').textContent = exposureLocked ? 'Unlock exposure' : 'Lock exposure & WB';
    toast(exposureLocked ? 'Exposure locked' : 'Auto exposure');
  } catch (err) {
    toast('Could not change exposure: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Region picking (white / black / crop)
// ---------------------------------------------------------------------------

async function startPick(kind) {
  if (!source || recorder) return;
  let bitmap = source.el, w = source.w, h = source.h;
  if (source.kind !== 'image') {
    if (source.kind === 'video') video.pause();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    bitmap = c;
  }
  looping = false;
  pick = { kind, bitmap, w, h, rect: null, quad: null, drag: null, corner: -1 };
  if (kind === 'crop') {
    pick.quad = crop ? crop.map((p) => [...p]) : null;
  } else {
    // Default sample: the middle of the picture area.
    const b = quadBounds(crop || FULL_QUAD);
    pick.rect = { x: b.x + b.w * 0.3, y: b.y + b.h * 0.3, w: b.w * 0.4, h: b.h * 0.4 };
  }
  stage.classList.add('picking');
  stage.style.touchAction = 'none';
  // Bring the whole photo into view below the sticky header.
  const top = stage.getBoundingClientRect().top + window.scrollY - document.querySelector('.topbar').offsetHeight - 8;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  $('pickBar').hidden = false;
  $('pickAuto').hidden = kind !== 'crop';
  $('pickHint').textContent = {
    white: 'Drag a box over the 100% white screen',
    black: 'Drag a box over the 0% black screen',
    crop: 'Drag the corners onto the picture edges',
  }[kind];
  updatePickOk();
  render();
}

function updatePickOk() {
  const ok = pick.kind === 'crop' ? !!pick.quad : !!pick.rect;
  $('pickOk').disabled = !ok;
}

function pickCanvasSize() {
  const ratio = pick.h / pick.w;
  const cssW = fitCanvasCSS(ratio);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cw = Math.round(Math.min(cssW * dpr, 2000));
  return { cw, ch: Math.round(cw * ratio), scale: cw / cssW };
}

function tracePoly(ctx, q, cw, ch) {
  ctx.moveTo(q[0][0] * cw, q[0][1] * ch);
  for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0] * cw, q[i][1] * ch);
  ctx.closePath();
}

function renderPick() {
  const { bitmap, w, h, rect, quad, kind } = pick;
  const { cw, ch, scale } = pickCanvasSize();
  view.width = cw;
  view.height = ch;
  const ctx = view.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h, 0, 0, cw, ch);
  const lw = Math.max(2, 1.5 * scale);
  const color = kind === 'black' ? '#7fb0ff' : '#e0b65a';
  if (crop && kind !== 'crop') {
    ctx.setLineDash([lw * 4, lw * 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = lw;
    ctx.beginPath(); tracePoly(ctx, crop, cw, ch); ctx.stroke();
    ctx.setLineDash([]);
  }
  const area = kind === 'crop' ? quad : rect && rectToQuad(rect);
  if (!area) return;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.rect(0, 0, cw, ch);
  tracePoly(ctx, area, cw, ch);
  ctx.fill('evenodd');
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath(); tracePoly(ctx, area, cw, ch); ctx.stroke();
  if (kind !== 'crop') return;

  // Corner handles
  const r = 11 * scale;
  quad.forEach(([x, y], i) => {
    ctx.beginPath();
    ctx.arc(x * cw, y * ch, r, 0, Math.PI * 2);
    ctx.fillStyle = i === pick.corner ? 'rgba(224,182,90,0.55)' : 'rgba(224,182,90,0.25)';
    ctx.fill();
    ctx.stroke();
  });
  // Loupe while dragging a corner: magnified view in the opposite top corner.
  if (pick.corner >= 0) {
    const [x, y] = quad[pick.corner];
    const L = Math.round(Math.min(cw, ch) * 0.36), zoom = 5;
    const lx = x < 0.5 ? cw - L - 8 * scale : 8 * scale, ly = 8 * scale;
    const sw = (L / zoom) * (w / cw), sh = (L / zoom) * (h / ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(lx, ly, L, L);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, x * w - sw / 2, y * h - sh / 2, sw, sh, lx, ly, L, L);
    // edges of the quad inside the loupe
    ctx.translate(lx + L / 2, ly + L / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-x * cw, -y * ch);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw / zoom;
    ctx.beginPath(); tracePoly(ctx, quad, cw, ch); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = lw;
    ctx.strokeRect(lx, ly, L, L);
    ctx.beginPath();
    ctx.moveTo(lx + L / 2, ly + L / 2 - 10 * scale); ctx.lineTo(lx + L / 2, ly + L / 2 + 10 * scale);
    ctx.moveTo(lx + L / 2 - 10 * scale, ly + L / 2); ctx.lineTo(lx + L / 2 + 10 * scale, ly + L / 2);
    ctx.stroke();
  }
}

function toNorm(e) {
  const r = view.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    r,
  };
}

view.addEventListener('pointerdown', (e) => {
  if (!pick) return;
  e.preventDefault();
  view.setPointerCapture(e.pointerId);
  const p = toNorm(e);
  pick.corner = -1;
  if (pick.kind === 'crop' && pick.quad) {
    // Grab the nearest corner if the finger is close to one.
    let best = -1, bd = 36;
    pick.quad.forEach(([x, y], i) => {
      const d = Math.hypot((x - p.x) * p.r.width, (y - p.y) * p.r.height);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) {
      pick.corner = best;
      pick.grab = [pick.quad[best][0] - p.x, pick.quad[best][1] - p.y];
      render();
      return;
    }
  }
  pick.drag = p;
  if (pick.kind === 'crop') pick.quad = null;
  else pick.rect = null;
  render();
});
view.addEventListener('pointermove', (e) => {
  if (!pick) return;
  const p = toNorm(e);
  if (pick.corner >= 0) {
    pick.quad[pick.corner] = [Math.min(1, Math.max(0, p.x + pick.grab[0])), Math.min(1, Math.max(0, p.y + pick.grab[1]))];
    render();
    return;
  }
  if (!pick.drag) return;
  const a = pick.drag;
  const r = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
  if (pick.kind === 'crop') pick.quad = rectToQuad(r);
  else pick.rect = r;
  render();
});
const endDrag = () => {
  if (!pick) return;
  if (pick.corner >= 0) {
    pick.corner = -1;
  } else if (pick.drag) {
    pick.drag = null;
    const b = pick.kind === 'crop' ? (pick.quad && quadBounds(pick.quad)) : pick.rect;
    if (!b || b.w < 0.01 || b.h < 0.01) {
      if (pick.kind === 'crop') pick.quad = null; else pick.rect = null;
    }
  }
  updatePickOk();
  render();
};
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

function pickAuto() {
  if (!pick || pick.kind !== 'crop') return;
  const r = detectOn(pick.bitmap, pick.w, pick.h);
  if (r) {
    pick.quad = r.quad;
    toast(r.ok ? (r.trimmed ? 'Picture found (black bars excluded). Adjust the corners if needed.' : 'Picture edges found. Adjust the corners if needed.')
      : 'Not sure about these edges. Please check the corners.', 4000);
  } else {
    toast('Couldn’t find the picture. Drag a box around it instead.');
  }
  updatePickOk();
  render();
}

function cancelPick() {
  if (!pick) return;
  pick = null;
  stage.classList.remove('picking');
  stage.style.touchAction = '';
  $('pickBar').hidden = true;
  if (source && source.kind === 'camera') startLoop();
  else requestRender();
}

function confirmPick() {
  if (!pick) return;
  const { kind, rect, bitmap, w, h } = pick;
  if (kind === 'crop') {
    if (!pick.quad) return;
    setCrop(pick.quad);
  } else {
    if (!rect) return;
    calibrateFrom(kind, bitmap, w, h, rect);
  }
  cancelPick();
}

/** Measure a white/black reference from `rect` (normalized) of a frame and store it. */
function calibrateFrom(kind, bitmap, w, h, rect, quiet = false) {
  {
    const sx = rect.x * w, sy = rect.y * h, sw = Math.max(1, rect.w * w), sh = Math.max(1, rect.h * h);
    const s = Math.min(1, 600 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s));
    c.height = Math.max(1, Math.round(sh * s));
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const m = measureRegion(cx.getImageData(0, 0, c.width, c.height).data);
    m.date = new Date().toISOString();
    calibration[kind] = m;
    let found = '';
    if (kind === 'white') {
      // A white frame is the most reliable view of the projector raster: remember it.
      const r = detectOn(bitmap, w, h, false);
      if (r && r.ok) {
        calibration.raster = r.raster;
        calibration.rasterSize = `${w}x${h}`;
        if (settings.cropOnLoad !== 'full') setCrop(r.quad);
        found = ' Picture edges found and remembered.';
      }
    }
    store.set('calibration', calibration);
    luts = rebuildLUTs();
    showCalibration();
    if (kind === 'white' && m.clipped > 0.02) {
      toast(`${Math.round(m.clipped * 100)}% of the white area is clipped by the camera. Lower the exposure and shoot it again for an accurate reference.`, 8000);
    } else if (kind === 'white' && Math.max(...m.codeMean) < 60) {
      toast('That white looks very dark. Is the exposure too low?');
    } else if (!quiet) {
      toast(kind === 'white' ? 'Reference white set: 100% = projector peak white.' + found : 'Reference black set');
    }
  }
}

// ---------------------------------------------------------------------------
// Sample photos (simulated phone shots of a projector, see samples/generate.py)
// ---------------------------------------------------------------------------

async function openSample(name) {
  const res = await fetch(`samples/${name}.jpg`);
  if (!res.ok) throw new Error('missing sample ' + name);
  const blob = await res.blob();
  await openFile(new File([blob], `${name}.jpg`, { type: 'image/jpeg' }));
}

async function trySamples() {
  try {
    for (const kind of ['white', 'black']) {
      await openSample(kind);
      const b = quadBounds(crop || FULL_QUAD);
      calibrateFrom(kind, source.el, source.w, source.h, { x: b.x + b.w * 0.3, y: b.y + b.h * 0.3, w: b.w * 0.4, h: b.h * 0.4 }, true);
    }
    await openSample('sunset');
    toast('Calibrated on the sample white and black frames. Showing the sunset; more samples are under Calibrate.', 6000);
  } catch (err) {
    toast('Couldn’t load the samples: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Saving + recording
// ---------------------------------------------------------------------------

function baseName(name) {
  return (name || 'image').replace(/\.[^.]+$/, '');
}

async function saveImage() {
  if (!source) return;
  const { natW } = pictureGeom(source.w, source.h);
  const maxW = settings.layout === 'side' ? 2000 : 2400;
  const W = Math.min(maxW, Math.max(1280, natW));
  const out = document.createElement('canvas');
  renderComposite(out, source.el, source.w, source.h, W, 2048);
  const type = settings.fileFormat === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => out.toBlob(r, type, 0.93));
  if (!blob) return toast('Could not create the image.');
  const suffix = source.kind === 'video' ? `_${video.currentTime.toFixed(2)}s` : '';
  await deliverFile(new File([blob], `${source.name}${suffix}_waveform.${settings.fileFormat === 'png' ? 'png' : 'jpg'}`, { type }));
}

function pickMime() {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

function startRecording() {
  if (!source || source.kind === 'image' || recorder) return;
  cancelPick();
  const mime = pickMime();
  const chunks = [];
  // Render once at the recording size before capturing so the stream starts at its final size.
  recorder = { pending: true };
  render();
  const streamOut = view.captureStream(30);
  let rec;
  try {
    rec = new MediaRecorder(streamOut, mime ? { mimeType: mime, videoBitsPerSecond: 16e6 } : undefined);
  } catch (err) {
    recorder = null;
    return toast('Recording is not supported here: ' + err.message);
  }
  recorder = rec;
  rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const type = rec.mimeType || mime || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    deliverFile(new File([blob], `${source ? source.name : 'video'}_waveform.${ext}`, { type }), true);
  };
  rec.start(500);
  $('recordBtn').classList.add('on');
  $('recordBtn').textContent = 'Stop';
  if (source.kind === 'video') {
    if (video.ended) video.currentTime = 0;
    video.play();
  }
  startLoop();
}

function stopRecording() {
  if (!recorder || !recorder.stop) { recorder = null; return; }
  const rec = recorder;
  recorder = null;
  if (rec.state !== 'inactive') rec.stop();
  $('recordBtn').classList.remove('on');
  $('recordBtn').textContent = 'Record';
  requestRender();
}

async function deliverFile(file, deferred = false) {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const canShare = coarse && navigator.canShare && navigator.canShare({ files: [file] });
  const share = async () => {
    try {
      await navigator.share({ files: [file], title: file.name });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return true;
      return false;
    }
  };
  if (canShare && !deferred && (await share())) return;
  const url = URL.createObjectURL(file);
  const actions = [];
  if (canShare) actions.push({ label: 'Save / Share', onClick: share });
  actions.push({ label: 'Download', href: url, download: file.name });
  toast(`${file.name} ready (${(file.size / 1048576).toFixed(1)} MB)`, 30000, actions);
  if (!canShare && !deferred) {
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg, ms = 3500, actions = []) {
  const el = $('toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  for (const a of actions) {
    const b = document.createElement(a.href ? 'a' : 'button');
    b.className = 'btn primary';
    b.style.marginLeft = '10px';
    b.textContent = a.label;
    if (a.href) { b.href = a.href; b.download = a.download; }
    if (a.onClick) b.onclick = () => { a.onClick(); el.hidden = true; };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function setSetting(key, value) {
  if (key === 'layout' && recorder) return toast('Stop recording to change the layout.');
  settings[key] = value;
  store.set('settings', settings);
  if (['cameraTF', 'displayTF', 'perChannel', 'format', 'sdrPeak', 'hdrPeak'].includes(key)) {
    luts = rebuildLUTs();
    showCalibration();
  }
  if (key === 'aspect') pictureCache.key = '';
  syncUI();
  requestRender();
}

function syncUI() {
  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const v = String(settings[seg.dataset.setting]);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === v));
  });
  document.querySelectorAll('select[data-setting], input[type=range][data-setting]').forEach((el) => {
    el.value = settings[el.dataset.setting];
  });
  document.querySelectorAll('input[type=checkbox][data-setting]').forEach((el) => {
    el.checked = !!settings[el.dataset.setting];
  });
  // Format-dependent legend labels and peak presets
  const hdr = settings.format === 'hdr';
  const pctBtn = document.querySelector('.seg[data-setting=scale] button[data-value=percent]');
  if (pctBtn) pctBtn.textContent = hdr ? '% peak' : 'IRE';
  const codeBtn = document.querySelector('.seg[data-setting=scale] button[data-value=code]');
  if (codeBtn) codeBtn.textContent = hdr ? 'PQ code' : '10-bit';
  const peakKey = hdr ? 'hdrPeak' : 'sdrPeak';
  const peakIn = $('peakNits');
  if (document.activeElement !== peakIn) peakIn.value = settings[peakKey];
  const presets = $('peakPresets');
  presets.innerHTML = PEAK_PRESETS[settings.format].map((n) =>
    `<button data-value="${n}" class="${Number(settings[peakKey]) === n ? 'on' : ''}">${n >= 1000 ? n / 1000 + 'k' : n}</button>`).join('');
  document.querySelectorAll('[data-show-when]').forEach((el) => {
    const [k, v] = el.dataset.showWhen.split('=');
    el.hidden = String(settings[k]) !== v;
  });
}

function bindUI() {
  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) setSetting(seg.dataset.setting, b.dataset.value);
    });
  });
  document.querySelectorAll('select[data-setting]').forEach((el) => {
    el.addEventListener('change', () => setSetting(el.dataset.setting, el.value));
  });
  document.querySelectorAll('input[type=range][data-setting]').forEach((el) => {
    el.addEventListener('input', () => setSetting(el.dataset.setting, Number(el.value)));
  });
  document.querySelectorAll('input[type=checkbox][data-setting]').forEach((el) => {
    el.addEventListener('change', () => setSetting(el.dataset.setting, el.checked));
  });

  $('peakNits').addEventListener('change', (e) => {
    const v = Math.min(10000, Math.max(1, Number(e.target.value) || 0));
    if (v) setSetting(settings.format === 'hdr' ? 'hdrPeak' : 'sdrPeak', v);
  });
  $('peakPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setSetting(settings.format === 'hdr' ? 'hdrPeak' : 'sdrPeak', Number(b.dataset.value));
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
    });
  });

  $('fileInput').addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });
  $('cameraBtn').addEventListener('click', startCamera);
  $('saveBtn').addEventListener('click', saveImage);
  $('recordBtn').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));
  $('setWhite').addEventListener('click', () => startPick('white'));
  $('setBlack').addEventListener('click', () => startPick('black'));
  $('setCrop').addEventListener('click', () => startPick('crop'));
  $('clearCrop').addEventListener('click', () => {
    setCrop(null);
    requestRender();
  });
  $('detectCrop').addEventListener('click', () => {
    if (!source) return;
    if (source.kind === 'video') video.pause();
    autoDetect(source.el, source.w, source.h);
    requestRender();
  });
  $('pickAuto').addEventListener('click', pickAuto);
  $('trySamples').addEventListener('click', trySamples);
  document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => {
    openSample(b.dataset.sample).catch((err) => toast(err.message));
  }));
  $('clearCal').addEventListener('click', () => {
    if (!calibration.white && !calibration.black) return;
    if (!confirm('Clear the stored white and black references?')) return;
    calibration = { white: null, black: null, raster: null };
    store.set('calibration', calibration);
    luts = rebuildLUTs();
    showCalibration();
    requestRender();
  });
  $('pickCancel').addEventListener('click', cancelPick);
  $('pickOk').addEventListener('click', confirmPick);
  $('lockExp').addEventListener('click', toggleExposureLock);
  $('ev').addEventListener('input', async (e) => {
    const track = stream?.getVideoTracks()[0];
    try { await track?.applyConstraints({ advanced: [{ exposureCompensation: Number(e.target.value) }] }); } catch { /* ignore */ }
  });

  // Video transport
  $('playBtn').addEventListener('click', () => {
    if (video.paused || video.ended) video.play();
    else video.pause();
  });
  $('seek').addEventListener('input', (e) => {
    if (video.duration) video.currentTime = (e.target.value / 1000) * video.duration;
  });
  video.addEventListener('play', () => { updatePlayUI(); startLoop(); });
  video.addEventListener('pause', updatePlayUI);
  video.addEventListener('seeked', () => { updatePlayUI(); requestRender(); });
  video.addEventListener('timeupdate', updatePlayUI);
  video.addEventListener('ended', () => {
    updatePlayUI();
    if (recorder && source?.kind === 'video') stopRecording();
  });

  new ResizeObserver(() => requestRender()).observe(stage);
  window.addEventListener('orientationchange', () => setTimeout(requestRender, 300));

  // Drag & drop on desktop
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
  });
}

function fmtTime(t) {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updatePlayUI() {
  if (!source || source.kind !== 'video') return;
  $('playBtn').textContent = video.paused || video.ended ? '▶' : '❚❚';
  if (video.duration) $('seek').value = Math.round((video.currentTime / video.duration) * 1000);
  $('timeLabel').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
}

bindUI();
syncUI();
showCalibration();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Expose a tiny hook for automated tests.
window.__wfm = { openFile, settings, get stats() { return lastStats; }, get calibration() { return calibration; } };
window.__wfmCrop = () => (pick && pick.quad) || crop;
