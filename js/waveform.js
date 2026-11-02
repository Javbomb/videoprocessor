// Waveform engine: transfer functions, calibration LUTs, waveform accumulation,
// statistics and rendering. No DOM dependencies except the render helpers that
// take a CanvasRenderingContext2D, so the maths can be unit tested in Node.

// ---------------------------------------------------------------------------
// Transfer functions
// ---------------------------------------------------------------------------

const pow = (x, e) => (x <= 0 ? 0 : Math.pow(x, e));

export const TRANSFERS = {
  srgb: {
    label: 'sRGB (phone photo)',
    toLinear: (v) => (v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)),
    fromLinear: (l) => (l <= 0.0031308 ? Math.max(l, 0) * 12.92 : 1.055 * pow(l, 1 / 2.4) - 0.055),
  },
  g22: { label: 'Gamma 2.2', toLinear: (v) => pow(v, 2.2), fromLinear: (l) => pow(l, 1 / 2.2) },
  g24: { label: 'Gamma 2.4 (BT.1886)', toLinear: (v) => pow(v, 2.4), fromLinear: (l) => pow(l, 1 / 2.4) },
  g26: { label: 'Gamma 2.6 (DCI)', toLinear: (v) => pow(v, 2.6), fromLinear: (l) => pow(l, 1 / 2.6) },
  linear: { label: 'Linear', toLinear: (v) => v, fromLinear: (l) => Math.max(l, 0) },
};

// Rec.709 luma weights (as used by DaVinci Resolve's Y waveform).
export const LUMA = [0.2126, 0.7152, 0.0722];

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Measure a region of RGBA pixels. Returns mean *linear* values for every
 * camera transfer so the user can change the transfer later without having
 * to re-pick, plus the fraction of pixels the camera clipped.
 */
export function measureRegion(data) {
  const n = data.length / 4;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let clipped = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    hist[0][r]++; hist[1][g]++; hist[2][b]++;
    if (r >= 254 || g >= 254 || b >= 254) clipped++;
  }
  const means = {};
  for (const key of Object.keys(TRANSFERS)) {
    const tf = TRANSFERS[key];
    means[key] = hist.map((h) => {
      let s = 0;
      for (let v = 0; v < 256; v++) if (h[v]) s += h[v] * tf.toLinear(v / 255);
      return n ? s / n : 0;
    });
  }
  const codeMean = hist.map((h) => {
    let s = 0;
    for (let v = 0; v < 256; v++) s += h[v] * v;
    return n ? s / n : 0;
  });
  return { means, codeMean, clipped: n ? clipped / n : 0, pixels: n };
}

/**
 * Build per-channel lookup tables from 8-bit camera code value to
 *  - sig:   estimated *signal* level that was sent to the projector (0..1 = black..reference white)
 *  - light: linear screen light relative to reference white (1.0 = white), for the stops scale
 */
export function buildLUTs({ cameraTF = 'srgb', displayTF = 'g24', perChannel = true, white = null, black = null } = {}) {
  const cam = TRANSFERS[cameraTF] || TRANSFERS.srgb;
  const disp = TRANSFERS[displayTF] || TRANSFERS.g24;
  const sig = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const light = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];

  const pickMeans = (ref) => (ref ? ref.means[cameraTF] || ref.means.srgb : null);
  let w = pickMeans(white);
  let b = pickMeans(black);
  if (w && !perChannel) {
    const yw = LUMA[0] * w[0] + LUMA[1] * w[1] + LUMA[2] * w[2];
    w = [yw, yw, yw];
    if (b) {
      const yb = LUMA[0] * b[0] + LUMA[1] * b[1] + LUMA[2] * b[2];
      b = [yb, yb, yb];
    }
  }

  for (let c = 0; c < 3; c++) {
    for (let v = 0; v < 256; v++) {
      const l = cam.toLinear(v / 255);
      if (!w) {
        // Uncalibrated: show the photo's own code values.
        sig[c][v] = v / 255;
        light[c][v] = l;
      } else {
        const wc = Math.max(w[c], 1e-6);
        const bc = b ? Math.min(b[c], wc * 0.999) : 0;
        light[c][v] = l / wc;
        // Invert a simple display model: L = black + (white - black) * signal^gamma
        const n = (l - bc) / (wc - bc);
        sig[c][v] = disp.fromLinear(n);
      }
    }
  }
  // 1024-entry versions: each 8-bit code covers [v-0.5, v+0.5]; picking a random
  // quarter-step per pixel dithers away the 256-level banding in the trace.
  const fine = (tab) => tab.map((_, c) => {
    const out = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const code = Math.min(255, Math.max(0, (i + 0.5) / 4 - 0.5));
      const lo = Math.floor(code), t = code - lo, hiV = Math.min(255, lo + 1);
      out[i] = tab[c][lo] * (1 - t) + tab[c][hiV] * t;
    }
    return out;
  });
  const sigFine = fine(sig);
  const lightFine = fine(light);
  const blackLight = w && b ? (LUMA[0] * b[0] + LUMA[1] * b[1] + LUMA[2] * b[2]) /
    (LUMA[0] * w[0] + LUMA[1] * w[1] + LUMA[2] * w[2]) : null;
  return { sig, light, sigFine, lightFine, calibrated: !!w, blackLight };
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/** Vertical range of the plot for a scale. Values outside are clamped to the edge rows. */
export function scaleRange(scale, stopsRange = 10) {
  if (scale === 'stops') return { lo: -stopsRange - 0.25, hi: 0.75 };
  return { lo: -0.03, hi: 1.07 };
}

/** Graticule lines: [{value, label, major}] in the scale's own units. */
export function graticule(scale, stopsRange = 10) {
  const lines = [];
  if (scale === 'code') {
    for (let i = 0; i <= 8; i++) {
      const cv = i === 8 ? 1023 : i * 128;
      lines.push({ value: cv / 1023, label: String(cv), major: i % 2 === 0 });
    }
  } else if (scale === 'percent') {
    for (let p = 0; p <= 100; p += 10) lines.push({ value: p / 100, label: p + '%', major: p % 50 === 0 });
  } else {
    for (let s = 0; s >= -stopsRange; s--) lines.push({ value: s, label: s === 0 ? '0 st' : String(s), major: s % 2 === 0 });
  }
  return lines;
}

export function formatValue(scale, v) {
  if (scale === 'code') return String(Math.round(v * 1023));
  return (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
}

// ---------------------------------------------------------------------------
// Waveform accumulation
// ---------------------------------------------------------------------------

const HIST_BINS = 4096;
const SIG_LO = -0.25, SIG_HI = 1.75;
const STOP_LO = -20, STOP_HI = 4;

/**
 * Accumulate a waveform.
 * @param {Uint8ClampedArray} data RGBA pixels
 * @param {number} width
 * @param {number} height
 * @param {object} opts {mode: 'luma'|'parade'|'overlay', scale: 'code'|'percent'|'stops',
 *                       columns, rows, luts, stopsRange}
 */
export function computeWaveform(data, width, height, opts) {
  const { mode = 'luma', scale = 'code', luts, stopsRange = 10 } = opts;
  const columns = Math.max(1, opts.columns | 0);
  const rows = Math.max(2, opts.rows | 0);
  const { lo, hi } = scaleRange(scale, stopsRange);
  const rowScale = (rows - 1) / (hi - lo);
  const stops = scale === 'stops';
  const toRow = (v) => {
    let r = Math.round((hi - v) * rowScale);
    return r < 0 ? 0 : r >= rows ? rows - 1 : r;
  };
  const toRowStops = (l) => toRow(l > 1e-9 ? Math.log2(l) : -99);

  const nCh = mode === 'luma' ? 1 : 3;
  const bins = [];
  for (let c = 0; c < nCh; c++) bins.push(new Uint32Array(columns * rows));

  const colMap = new Int32Array(width);
  for (let x = 0; x < width; x++) colMap[x] = Math.min(columns - 1, Math.floor((x * columns) / width));

  // Per-channel row LUTs for RGB modes (row only depends on the 8-bit value).
  const sigF = luts.sigFine || luts.sig;
  const lightF = luts.lightFine || luts.light;
  const fineShift = sigF[0].length === 1024 ? 2 : 0;
  const rowLut = [0, 1, 2].map((c) => {
    const t = new Int32Array(sigF[c].length);
    for (let v = 0; v < t.length; v++) t[v] = stops ? toRowStops(lightF[c][v]) : toRow(sigF[c][v]);
    return t;
  });

  const sigHist = new Uint32Array(HIST_BINS);
  const lightHist = new Uint32Array(HIST_BINS);
  const sigBinScale = HIST_BINS / (SIG_HI - SIG_LO);
  const stopBinScale = HIST_BINS / (STOP_HI - STOP_LO);
  const [sR, sG, sB] = sigF;
  const [lR, lG, lB] = lightF;
  const dMask = fineShift ? 3 : 0;
  let seed = 0x9e3779b9;
  const [kr, kg, kb] = LUMA;
  let clipped = 0, overWhite = 0, sum = 0;

  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const col = colMap[x];
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const ri = (r << fineShift) | (seed & dMask);
      const gi = (g << fineShift) | ((seed >>> 2) & dMask);
      const bi = (b << fineShift) | ((seed >>> 4) & dMask);
      const ys = kr * sR[ri] + kg * sG[gi] + kb * sB[bi];
      const yl = kr * lR[ri] + kg * lG[gi] + kb * lB[bi];
      const lg = yl > 1e-9 ? Math.log2(yl) : -99;

      if (nCh === 1) {
        bins[0][(stops ? toRow(lg) : toRow(ys)) * columns + col]++;
      } else {
        bins[0][rowLut[0][ri] * columns + col]++;
        bins[1][rowLut[1][gi] * columns + col]++;
        bins[2][rowLut[2][bi] * columns + col]++;
      }

      let hb = ((ys - SIG_LO) * sigBinScale) | 0;
      sigHist[hb < 0 ? 0 : hb >= HIST_BINS ? HIST_BINS - 1 : hb]++;
      hb = ((lg - STOP_LO) * stopBinScale) | 0;
      lightHist[hb < 0 ? 0 : hb >= HIST_BINS ? HIST_BINS - 1 : hb]++;
      if (r >= 254 || g >= 254 || b >= 254) clipped++;
      if (ys > 1.005) overWhite++;
      sum += ys;
    }
  }

  const n = width * height;
  const pct = (hist, p, lo, hi) => {
    const target = p * n;
    let acc = 0;
    for (let k = 0; k < HIST_BINS; k++) {
      acc += hist[k];
      if (acc >= target) return lo + ((k + 0.5) * (hi - lo)) / HIST_BINS;
    }
    return hi;
  };
  const floorStops = pct(lightHist, 0.001, STOP_LO, STOP_HI);
  const peakStops = pct(lightHist, 0.999, STOP_LO, STOP_HI);
  const stats = {
    floor: pct(sigHist, 0.001, SIG_LO, SIG_HI),
    peak: pct(sigHist, 0.999, SIG_LO, SIG_HI),
    median: pct(sigHist, 0.5, SIG_LO, SIG_HI),
    mean: n ? sum / n : 0,
    floorStops,
    peakStops,
    rangeStops: peakStops - floorStops,
    clipped: n ? clipped / n : 0,
    overWhite: n ? overWhite / n : 0,
    pixels: n,
  };

  return { bins, columns, rows, samplesPerColumn: height * (width / columns), mode, scale, stopsRange, stats };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TRACE_COLORS = {
  luma: [[205, 240, 215]],
  rgb: [[255, 72, 64], [64, 255, 96], [72, 140, 255]],
};

/** Convert accumulated bins to an RGBA ImageData-compatible buffer (alpha = intensity). */
export function traceToRGBA(wf, gain = 1.5) {
  const { bins, columns, rows, samplesPerColumn } = wf;
  const k = (gain * 0.35 * rows) / Math.max(1, samplesPerColumn);
  const colors = bins.length === 1 ? TRACE_COLORS.luma : TRACE_COLORS.rgb;
  const intensity = new Float32Array(1024);
  // count -> intensity via 1 - exp(-k*count); cache for small counts.
  for (let c = 0; c < intensity.length; c++) intensity[c] = 1 - Math.exp(-k * c);
  const out = [];
  for (let ch = 0; ch < bins.length; ch++) {
    const b = bins[ch];
    const px = new Uint8ClampedArray(columns * rows * 4);
    const [cr, cg, cb] = colors[ch];
    for (let i = 0, j = 0; i < b.length; i++, j += 4) {
      const cnt = b[i];
      if (!cnt) continue;
      const a = cnt < 1024 ? intensity[cnt] : 1 - Math.exp(-k * cnt);
      // Hot spots bloom towards white, like a phosphor scope.
      const hot = a > 0.85 ? (a - 0.85) / 0.15 : 0;
      px[j] = cr + (255 - cr) * hot * 0.6;
      px[j + 1] = cg + (255 - cg) * hot * 0.6;
      px[j + 2] = cb + (255 - cb) * hot * 0.6;
      px[j + 3] = a * 255;
    }
    out.push(px);
  }
  return out;
}

/**
 * Draw a full scope panel into ctx at (x, y, w, h).
 * opts: {gain, background (css color|null), luts, calibrated, showLabels, statsText}
 */
export function drawScope(ctx, wf, x, y, w, h, opts = {}) {
  const { gain = 1.5, background = '#0b0d0e', blackLight = null, statsText = '' } = opts;
  const { lo, hi } = scaleRange(wf.scale, wf.stopsRange);
  const panels = wf.mode === 'parade' ? 3 : 1;
  const font = Math.max(10, Math.round(Math.min(w / 40, Math.max(h / 28, w / 70))));

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(x, y, w, h);
  }

  const rowToY = (v) => y + ((hi - v) / (hi - lo)) * (h - 1);
  const lines = graticule(wf.scale, wf.stopsRange);

  // Graticule
  ctx.lineWidth = Math.max(1, Math.round(h / 400));
  for (const ln of lines) {
    const ly = Math.round(rowToY(ln.value)) + 0.5;
    ctx.strokeStyle = ln.major ? 'rgba(200,170,90,0.42)' : 'rgba(200,170,90,0.22)';
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + w, ly);
    ctx.stroke();
  }
  if (wf.scale === 'stops' && blackLight) {
    const ly = Math.round(rowToY(Math.log2(blackLight))) + 0.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(120,170,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(x, ly);
    ctx.lineTo(x + w, ly);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Trace
  const rgba = traceToRGBA(wf, gain);
  const tmp = makeCanvas(wf.columns, wf.rows);
  const tctx = tmp.getContext('2d');
  const panelW = w / panels;
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = 'lighter';
  for (let ch = 0; ch < rgba.length; ch++) {
    tctx.putImageData(new ImageData(rgba[ch], wf.columns, wf.rows), 0, 0);
    const px = panels === 3 ? x + ch * panelW : x;
    ctx.drawImage(tmp, px, y, panelW, h);
  }
  ctx.globalCompositeOperation = 'source-over';

  // Parade separators
  if (panels === 3) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    for (let p = 1; p < 3; p++) {
      const sx = Math.round(x + p * panelW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, y);
      ctx.lineTo(sx, y + h);
      ctx.stroke();
    }
  }

  // Labels
  ctx.font = `${font}px ui-monospace, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(225,200,140,0.85)';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 3;
  for (const ln of lines) {
    if (!ln.major && h < 260) continue;
    const ly = rowToY(ln.value);
    ctx.fillText(ln.label, x + font * 0.4, Math.min(Math.max(ly, y + font * 0.6), y + h - font * 0.6));
  }
  if (statsText) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(235,235,235,0.9)';
    const lines2 = Array.isArray(statsText) ? statsText : [statsText];
    const tw = Math.max(...lines2.map((t) => ctx.measureText(t).width));
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x + w - tw - font, y, tw + font, font * (0.8 + lines2.length * 1.25));
    ctx.fillStyle = 'rgba(235,235,235,0.9)';
    lines2.forEach((t, i) => ctx.fillText(t, x + w - font * 0.5, y + font * 0.4 + i * font * 1.25));
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Human readable stats lines for a scale. */
export function statsLines(stats, scale, calibrated) {
  const f = (v) => formatValue(scale === 'stops' ? 'percent' : scale, v);
  const sig = `Floor ${f(stats.floor)}  Peak ${f(stats.peak)}  Mean ${f(stats.mean)}`;
  const dr = calibrated
    ? `Light ${stats.peakStops.toFixed(1)} → ${stats.floorStops.toFixed(1)} st  (${stats.rangeStops.toFixed(1)} stops)`
    : `Range ${stats.rangeStops.toFixed(1)} stops (uncalibrated)`;
  return [sig, dr];
}
