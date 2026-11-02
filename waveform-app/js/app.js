import { buildLUTs, computeWaveform, drawScope, statsLines, measureRegion, formatValue, LUMA } from './waveform.js';

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
  mode: 'luma', scale: 'code', stopsRange: 12, gain: 1.5,
  cameraTF: 'srgb', displayTF: 'g24', perChannel: true,
  layout: 'stacked', burnStats: true, format: 'jpeg', keepCrop: false,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
let calibration = store.get('calibration', { white: null, black: null });
let crop = settings.keepCrop ? store.get('crop', null) : null; // normalized {x,y,w,h}
let luts = rebuildLUTs();

let source = null; // {kind: 'image'|'video'|'camera', el, w, h, name}
let stream = null;
let pick = null; // {kind, bitmap, w, h, rect, drag}
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

function layoutDims(W, aspect) {
  W = even(W);
  const ih = even(W * aspect);
  switch (settings.layout) {
    case 'side':
      return { cw: W * 2, ch: ih, img: { x: 0, y: 0, w: W, h: ih }, scope: { x: W, y: 0, w: W, h: ih } };
    case 'overlay': {
      const sh = even(ih * 0.42);
      return { cw: W, ch: ih, img: { x: 0, y: 0, w: W, h: ih }, scope: { x: 0, y: ih - sh, w: W, h: sh }, overlay: true };
    }
    case 'scope': {
      const sh = even(W * 0.5);
      return { cw: W, ch: sh, img: null, scope: { x: 0, y: 0, w: W, h: sh } };
    }
    default: {
      const sh = even(W * 0.5);
      return { cw: W, ch: ih + sh, img: { x: 0, y: 0, w: W, h: ih }, scope: { x: 0, y: ih, w: W, h: sh } };
    }
  }
}

function cropRect(frameW, frameH) {
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  return { sx: c.x * frameW, sy: c.y * frameH, sw: Math.max(1, c.w * frameW), sh: Math.max(1, c.h * frameH) };
}

/** Render the composite of `frame` into `canvas` with image width W. Returns stats. */
function renderComposite(canvas, frame, frameW, frameH, W, analysisMax) {
  const { sx, sy, sw, sh } = cropRect(frameW, frameH);
  const aspect = sh / sw;
  const d = layoutDims(W, aspect);
  if (canvas.width !== d.cw) canvas.width = d.cw;
  if (canvas.height !== d.ch) canvas.height = d.ch;
  const ctx = canvas.getContext('2d');

  // Analysis pass on a down-scaled copy of the cropped frame.
  let aw = Math.min(sw, analysisMax);
  let ah = aw * aspect;
  if (ah > analysisMax) { ah = analysisMax; aw = ah / aspect; }
  aw = Math.max(8, Math.round(aw));
  ah = Math.max(8, Math.round(ah));
  if (work.width !== aw) work.width = aw;
  if (work.height !== ah) work.height = ah;
  workCtx.imageSmoothingQuality = 'medium';
  workCtx.drawImage(frame, sx, sy, sw, sh, 0, 0, aw, ah);
  const data = workCtx.getImageData(0, 0, aw, ah).data;

  const panelW = settings.mode === 'parade' ? d.scope.w / 3 : d.scope.w;
  const wf = computeWaveform(data, aw, ah, {
    mode: settings.mode,
    scale: settings.scale,
    columns: Math.min(Math.round(panelW), aw),
    rows: d.scope.h,
    luts,
    stopsRange: Number(settings.stopsRange),
  });

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, d.cw, d.ch);
  if (d.img) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, sx, sy, sw, sh, d.img.x, d.img.y, d.img.w, d.img.h);
  }
  drawScope(ctx, wf, d.scope.x, d.scope.y, d.scope.w, d.scope.h, {
    gain: Number(settings.gain),
    background: d.overlay ? 'rgba(0,0,0,0.55)' : '#0b0d0e',
    blackLight: luts.blackLight,
    statsText: settings.burnStats ? statsLines(wf.stats, settings.scale, luts.calibrated) : '',
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
  const { sw, sh } = cropRect(source.w, source.h);
  const aspect = sh / sw;
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
  const sc = settings.scale === 'stops' ? 'percent' : settings.scale;
  const f = (v) => formatValue(sc, v);
  const parts = [
    `<b>Peak</b> ${f(s.peak)}`,
    `<b>Floor</b> ${f(s.floor)}`,
    `<b>Mean</b> ${f(s.mean)}`,
    `<b>Range</b> ${s.rangeStops.toFixed(1)} stops`,
  ];
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

function rebuildLUTs() {
  return buildLUTs({
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
  if (!settings.keepCrop) crop = null;
  $('empty').hidden = !!src;
  $('saveBtn').disabled = !src;
  $('setWhite').disabled = !src;
  $('setBlack').disabled = !src;
  $('setCrop').disabled = !src;
  const moving = src && (src.kind === 'video' || src.kind === 'camera');
  $('recordBtn').hidden = !moving || typeof MediaRecorder === 'undefined';
  $('videoBar').hidden = !src || src.kind !== 'video';
  $('camControls').hidden = !src || src.kind !== 'camera';
  $('cameraBtn').classList.toggle('primary', !!src && src.kind === 'camera');
  if (moving) startLoop();
  else requestRender();
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
  let rect;
  if (kind === 'crop') rect = crop ? { ...crop } : null;
  else {
    const c = crop || { x: 0, y: 0, w: 1, h: 1 };
    rect = { x: c.x + c.w * 0.3, y: c.y + c.h * 0.3, w: c.w * 0.4, h: c.h * 0.4 };
  }
  pick = { kind, bitmap, w, h, rect, drag: null };
  stage.classList.add('picking');
  stage.style.touchAction = 'none';
  $('pickBar').hidden = false;
  $('pickHint').textContent = {
    white: 'Drag a box over the 100% white screen',
    black: 'Drag a box over the 0% black screen',
    crop: 'Drag a box around the projected picture',
  }[kind];
  $('pickOk').disabled = !rect;
  render();
}

function renderPick() {
  const { bitmap, w, h, rect, kind } = pick;
  const ratio = h / w;
  const cssW = fitCanvasCSS(ratio);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cw = Math.round(Math.min(cssW * dpr, 2000));
  const ch = Math.round(cw * ratio);
  view.width = cw;
  view.height = ch;
  const ctx = view.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h, 0, 0, cw, ch);
  const lw = Math.max(2, cw / 400);
  if (crop && kind !== 'crop') {
    ctx.setLineDash([lw * 4, lw * 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = lw;
    ctx.strokeRect(crop.x * cw, crop.y * ch, crop.w * cw, crop.h * ch);
    ctx.setLineDash([]);
  }
  if (rect) {
    const x = rect.x * cw, y = rect.y * ch, rw = rect.w * cw, rh = rect.h * ch;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(x, y, rw, rh);
    ctx.fill('evenodd');
    ctx.strokeStyle = kind === 'black' ? '#7fb0ff' : '#e0b65a';
    ctx.lineWidth = lw;
    ctx.strokeRect(x, y, rw, rh);
  }
}

function toNorm(e) {
  const r = view.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

view.addEventListener('pointerdown', (e) => {
  if (!pick) return;
  e.preventDefault();
  view.setPointerCapture(e.pointerId);
  const p = toNorm(e);
  pick.drag = p;
  pick.rect = { x: p.x, y: p.y, w: 0, h: 0 };
  render();
});
view.addEventListener('pointermove', (e) => {
  if (!pick || !pick.drag) return;
  const p = toNorm(e), a = pick.drag;
  pick.rect = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
  render();
});
const endDrag = () => {
  if (!pick || !pick.drag) return;
  pick.drag = null;
  const ok = pick.rect && pick.rect.w > 0.005 && pick.rect.h > 0.005;
  if (!ok) pick.rect = null;
  $('pickOk').disabled = !ok;
  render();
};
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

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
  if (!pick || !pick.rect) return;
  const { kind, rect, bitmap, w, h } = pick;
  if (kind === 'crop') {
    crop = rect;
    if (settings.keepCrop) store.set('crop', crop);
  } else {
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
    store.set('calibration', calibration);
    luts = rebuildLUTs();
    showCalibration();
    if (kind === 'white' && m.clipped > 0.02) {
      toast(`${Math.round(m.clipped * 100)}% of the white area is clipped by the camera. Lower the exposure and shoot it again for an accurate reference.`, 8000);
    } else if (kind === 'white' && Math.max(...m.codeMean) < 60) {
      toast('That white looks very dark — is the exposure too low?');
    } else {
      toast(kind === 'white' ? 'Reference white set: 100% = projector peak white' : 'Reference black set');
    }
  }
  cancelPick();
}

// ---------------------------------------------------------------------------
// Saving + recording
// ---------------------------------------------------------------------------

function baseName(name) {
  return (name || 'image').replace(/\.[^.]+$/, '');
}

async function saveImage() {
  if (!source) return;
  const { sw } = cropRect(source.w, source.h);
  const maxW = settings.layout === 'side' ? 2000 : 2400;
  const W = Math.min(maxW, Math.max(1280, sw));
  const out = document.createElement('canvas');
  renderComposite(out, source.el, source.w, source.h, W, 2048);
  const type = settings.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => out.toBlob(r, type, 0.93));
  if (!blob) return toast('Could not create the image.');
  const suffix = source.kind === 'video' ? `_${video.currentTime.toFixed(2)}s` : '';
  await deliverFile(new File([blob], `${source.name}${suffix}_waveform.${settings.format === 'png' ? 'png' : 'jpg'}`, { type }));
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
  if (['cameraTF', 'displayTF', 'perChannel'].includes(key)) {
    luts = rebuildLUTs();
    showCalibration();
  }
  if (key === 'keepCrop') store.set('crop', value ? crop : null);
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
    crop = null;
    store.set('crop', null);
    requestRender();
  });
  $('clearCal').addEventListener('click', () => {
    if (!calibration.white && !calibration.black) return;
    if (!confirm('Clear the stored white and black references?')) return;
    calibration = { white: null, black: null };
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
