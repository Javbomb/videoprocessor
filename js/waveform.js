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

// SMPTE ST 2084 (PQ). Absolute: 1.0 = 10,000 nits.
const PQ_M1 = 2610 / 16384, PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096, PQ_C2 = (2413 / 4096) * 32, PQ_C3 = (2392 / 4096) * 32;

/** nits -> PQ signal (0..1) */
export function pqEncode(nits) {
  if (!(nits > 0)) return 0;
  const p = Math.pow(Math.min(Math.max(nits, 0), 10000) / 10000, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * p) / (1 + PQ_C3 * p), PQ_M2);
}

/** PQ signal (0..1) -> nits */
export function pqDecode(e) {
  const p = Math.pow(Math.min(Math.max(e, 0), 1), 1 / PQ_M2);
  return 10000 * Math.pow(Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
}

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
 *  - sig:   estimated SDR *signal* sent to the projector (0..1 = black..reference white)
 *  - light: linear screen light relative to reference white (1.0 = peak white)
 *  - pqFine: HDR axis position, PQ(light * peakNits) / PQ(peakNits)  (0..1 = 0 nits..peak)
 */
export function buildLUTs({ cameraTF = 'srgb', displayTF = 'g24', perChannel = true, white = null, black = null, peakNits = 1000, format = 'sdr' } = {}) {
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
        // Uncalibrated: read the file's own code values as the video signal (like
        // Resolve on a frame grab). Light comes from the display EOTF: the SDR gamma,
        // or PQ for HDR (absolute nits, relative to the chosen peak).
        sig[c][v] = v / 255;
        light[c][v] = format === 'hdr' ? pqDecode(v / 255) / peakNits : disp.toLinear(v / 255);
      } else {
        const wc = Math.max(w[c], 1e-6);
        const bc = b ? Math.min(b[c], wc * 0.999) : 0;
        light[c][v] = l / wc;
        // Invert a simple display model: L = black + (white - black) * signal^gamma
        sig[c][v] = disp.fromLinear((l - bc) / (wc - bc));
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
  const pqPeak = pqEncode(peakNits);
  const pqFine = lightFine.map((t) => t.map((l) => pqEncode(l * peakNits) / pqPeak));
  const blackLight = w && b ? (LUMA[0] * b[0] + LUMA[1] * b[1] + LUMA[2] * b[2]) /
    (LUMA[0] * w[0] + LUMA[1] * w[1] + LUMA[2] * w[2]) : null;
  return { sig, light, sigFine, lightFine, pqFine, peakNits, calibrated: !!w, blackLight };
}

// ---------------------------------------------------------------------------
// Axes and legends
// ---------------------------------------------------------------------------
//
// The vertical axis always runs from 0 (black / 0 nits) at the bottom to 1
// (calibrated peak white) at the top, with a little headroom above.
//   'sdr'   : gamma-encoded SDR signal (IRE)
//   'pq'    : PQ-encoded, normalised so peak white = 1 (HDR)
//   'stops' : log2 of light relative to peak white

/** Which axis a format + unit selection uses. */
export function axisFor(format, unit) {
  if (unit === 'stops') return 'stops';
  return format === 'hdr' ? 'pq' : 'sdr';
}

/** Vertical range of the plot for an axis. Values outside are clamped to the edge rows. */
export function scaleRange(axis, stopsRange = 10) {
  if (axis === 'stops') return { lo: -stopsRange - 0.25, hi: 0.75 };
  return { lo: -0.03, hi: 1.07 };
}

/** Axis position of a light level given as a fraction of peak white. */
export function lightToAxis(rel, axis, { peakNits = 100, displayTF = 'g24' } = {}) {
  if (axis === 'stops') return rel > 1e-9 ? Math.log2(rel) : -99;
  if (axis === 'pq') return pqEncode(rel * peakNits) / pqEncode(peakNits);
  return (TRANSFERS[displayTF] || TRANSFERS.g24).fromLinear(rel);
}

const NITS_STEPS = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 4000, 10000];
const PCT_STEPS = [0.1, 0.5, 1, 2, 5, 10, 20, 50];
const isDecade = (n) => Math.abs(Math.log10(n) - Math.round(Math.log10(n))) < 1e-9;

export function fmtNits(n) {
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(n >= 0.1 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Graticule lines [{value, label, major}] with value in axis units.
 * unit: 'percent' (IRE for SDR, % of peak light for HDR) | 'nits' | 'code' | 'stops'
 */
export function graticule(axis, unit, o = {}) {
  const { peakNits = 100, stopsRange = 10 } = o;
  const lines = [];
  const MIN_GAP = 0.045;
  // Add lines bottom-up, skipping ones that would crowd their neighbour or the top line.
  const ladder = (items) => {
    let last = 0;
    lines.push({ value: 0, label: '0', major: true });
    for (const it of items) {
      if (it.value - last >= MIN_GAP && 1 - it.value >= MIN_GAP) {
        lines.push(it);
        last = it.value;
      }
    }
  };

  if (axis === 'stops') {
    for (let s = 0; s >= -stopsRange; s--) {
      const label = s === 0 ? `0 st = ${fmtNits(peakNits)} nits` : String(s);
      lines.push({ value: s, label, major: s % 2 === 0 });
    }
  } else if (unit === 'nits') {
    ladder(NITS_STEPS.filter((n) => n < peakNits * 0.999)
      .map((n) => ({ value: lightToAxis(n / peakNits, axis, o), label: fmtNits(n), major: isDecade(n) })));
    lines.push({ value: 1, label: `${fmtNits(peakNits)} nits`, major: true });
  } else if (unit === 'code') {
    if (axis === 'pq') {
      const top = pqEncode(peakNits);
      const topCode = Math.round(top * 1023);
      const items = [];
      for (let cv = 64; cv < topCode; cv += 64) items.push({ value: cv / 1023 / top, label: String(cv), major: cv % 256 === 0 });
      ladder(items);
      lines.push({ value: 1, label: `${topCode} (PQ)`, major: true });
    } else {
      for (let i = 0; i <= 8; i++) {
        const cv = i === 8 ? 1023 : i * 128;
        lines.push({ value: cv / 1023, label: String(cv), major: i % 2 === 0 });
      }
    }
  } else if (axis === 'pq') {
    // % of peak light, PQ spaced
    ladder(PCT_STEPS.map((p) => ({ value: lightToAxis(p / 100, axis, o), label: p + '%', major: isDecade(p) })));
    lines.push({ value: 1, label: '100%', major: true });
  } else {
    for (let p = 0; p <= 100; p += 10) lines.push({ value: p / 100, label: p === 100 ? '100 IRE' : String(p), major: true });
  }
  return lines;
}

/** Minor ruler ticks (axis values) between the graticule lines. */
export function minorTicks(axis, unit, o = {}) {
  const { peakNits = 100, stopsRange = 10 } = o;
  const out = [];
  if (axis === 'stops') {
    for (let s = 0; s >= -stopsRange; s -= 0.25) if (s % 1) out.push(s);
  } else if (axis === 'sdr' && unit === 'code') {
    for (let cv = 32; cv < 1023; cv += 32) if (cv % 128) out.push(cv / 1023);
  } else if (axis === 'sdr' && unit === 'nits') {
    for (const n of decadeSteps(peakNits)) out.push(lightToAxis(n / peakNits, axis, o));
  } else if (axis === 'sdr') {
    for (let p = 2; p < 100; p += 2) if (p % 10) out.push(p / 100);
  } else if (unit === 'code') {
    const top = pqEncode(peakNits);
    for (let cv = 16; cv < top * 1023; cv += 16) if (cv % 64) out.push(cv / 1023 / top);
  } else if (unit === 'nits') {
    for (const n of decadeSteps(peakNits)) out.push(lightToAxis(n / peakNits, axis, o));
  } else {
    for (const p of decadeSteps(100)) out.push(lightToAxis(p / 100, axis, o));
  }
  return out.filter((v) => v > 0 && v < 1 || axis === 'stops');
}

/** 1..9 x each decade below `top` (log-style minor ticks). */
function decadeSteps(top) {
  const out = [];
  for (let d = 0.01; d < top; d *= 10) for (let k = 1; k <= 9; k++) if (k * d < top) out.push(k * d);
  return out;
}

/**
 * Format the statistics for display.
 *  peak / floor: in the selected unit
 *  apl: average picture level, the mean *signal* (IRE in SDR, PQ code/percent in HDR)
 *  adl: average display level, the mean *light* on screen as % of peak white and in nits
 * o: {format: 'sdr'|'hdr', unit, peakNits}
 */
export function formatStats(stats, o) {
  const { format = 'sdr', unit = 'percent', peakNits = 100 } = o;
  const nits = { peak: peakNits * 2 ** stats.peakStops, floor: peakNits * 2 ** stats.floorStops, mean: peakNits * stats.meanLight };
  const each = (fn) => ({ peak: fn('peak'), floor: fn('floor'), mean: fn('mean') });
  let f;
  if (unit === 'nits' || (unit === 'stops' && format === 'hdr')) f = each((k) => fmtNits(nits[k]) + ' nits');
  else if (format === 'sdr' && unit === 'code') f = each((k) => String(Math.round(stats[k] * 1023)));
  else if (format === 'sdr') f = each((k) => (stats[k] * 100).toFixed(0) + ' IRE');
  else if (unit === 'code') f = each((k) => String(Math.round(pqEncode(nits[k]) * 1023)));
  else f = each((k) => pct((nits[k] / peakNits) * 100));
  const adlPct = stats.meanLight * 100;
  return {
    ...f,
    apl: format === 'sdr' ? (unit === 'code' ? String(Math.round(stats.mean * 1023)) : (stats.mean * 100).toFixed(0) + ' IRE') : null,
    adl: `${pct(adlPct)} (${fmtNits(nits.mean)} nits)`,
    adlPct,
    adlNits: nits.mean,
  };
}

const pct = (p) => (p < 10 ? p.toFixed(1) : p.toFixed(0)) + '%';

/** Two short lines of stats to burn into the scope. */
export function statsLines(stats, o) {
  const f = formatStats(stats, o);
  const cal = o.calibrated ? '' : ' (uncalibrated)';
  return [
    `Peak ${f.peak}  Floor ${f.floor}${f.apl ? '  APL ' + f.apl : ''}`,
    `ADL ${f.adl}  ${stats.rangeStops.toFixed(1)} stops${cal}`,
  ];
}

/**
 * Low-pass filter (like the LPF option on Resolve's scopes and hardware waveform
 * monitors): an approximately Gaussian blur, three box passes of `radius`, applied
 * in place to RGBA pixels. Removes camera noise and fine texture so the trace
 * shows the picture's tonal structure.
 */
export function lowPassRGBA(data, w, h, radius) {
  const r = Math.max(0, Math.round(radius));
  if (!r) return data;
  const n = w * h;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, j = 0; i < n; i++, j += 4) { ch[0][i] = data[j]; ch[1][i] = data[j + 1]; ch[2][i] = data[j + 2]; }
  const tmp = new Float32Array(Math.max(w, h));
  const pass = (a, len, count, stride, step) => {
    // box blur along lines: `count` lines of `len` samples
    for (let l = 0; l < count; l++) {
      const base = l * stride;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[base + Math.min(len - 1, Math.max(0, k)) * step];
      for (let x = 0; x < len; x++) {
        tmp[x] = acc / (2 * r + 1);
        acc += a[base + Math.min(len - 1, x + r + 1) * step] - a[base + Math.max(0, x - r) * step];
      }
      for (let x = 0; x < len; x++) a[base + x * step] = tmp[x];
    }
  };
  for (const a of ch) {
    for (let it = 0; it < 3; it++) {
      pass(a, w, h, w, 1);
      pass(a, h, w, 1, w);
    }
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) { data[j] = ch[0][i]; data[j + 1] = ch[1][i]; data[j + 2] = ch[2][i]; }
  return data;
}

/** Low-pass radius (analysis pixels) for a strength setting and analysis width. */
export function lowPassRadius(level, analysisWidth) {
  if (level === 'high') return Math.max(2, Math.round(analysisWidth / 300));
  if (level === 'low') return Math.max(1, Math.round(analysisWidth / 550));
  return 0;
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
 * @param {object} opts {mode: 'luma'|'parade'|'overlay', axis: 'sdr'|'pq'|'stops',
 *                       columns, rows, luts, stopsRange}
 */
export function computeWaveform(data, width, height, opts) {
  const { mode = 'overlay', axis = 'sdr', luts, stopsRange = 10, style = 'lines' } = opts;
  const columns = Math.max(1, opts.columns | 0);
  const rows = Math.max(2, opts.rows | 0);
  const { lo, hi } = scaleRange(axis, stopsRange);
  // Continuous vertical position in "cell" units: row k covers [k, k + 1).
  const cellScale = rows / (hi - lo);
  const maxPos = rows - 1e-4;
  const stops = axis === 'stops';
  const lines = style !== 'points';

  const nCh = mode === 'luma' ? 1 : 3;
  const bins = [];
  for (let c = 0; c < nCh; c++) bins.push(new Float32Array(columns * rows));

  const colMap = new Int32Array(width);
  for (let x = 0; x < width; x++) colMap[x] = Math.min(columns - 1, Math.floor((x * columns) / width));

  const sigF = luts.sigFine || luts.sig;
  const lightF = luts.lightFine || luts.light;
  const axisF = axis === 'pq' ? luts.pqFine : sigF;
  const fineShift = sigF[0].length === 1024 ? 2 : 0;
  // Per-channel position LUTs (position depends only on the channel value).
  const posOf = (v) => {
    const p = (hi - v) * cellScale;
    return p < 0 ? 0 : p > maxPos ? maxPos : p;
  };
  const posLut = [0, 1, 2].map((c) => {
    const t = new Float32Array(sigF[c].length);
    for (let v = 0; v < t.length; v++) t[v] = posOf(stops ? (lightF[c][v] > 1e-9 ? Math.log2(lightF[c][v]) : -99) : axisF[c][v]);
    return t;
  });

  // Strokes are deposited box-filtered into rows (sub-pixel accurate, anti-aliased).
  // Full interior rows of long strokes go into a difference array (O(1) per stroke),
  // integrated once at the end.
  const diffs = [];
  for (let c = 0; c < nCh; c++) diffs.push(lines ? new Float32Array(columns * (rows + 1)) : null);

  const sigHist = new Uint32Array(HIST_BINS);
  const lightHist = new Uint32Array(HIST_BINS);
  const sigBinScale = HIST_BINS / (SIG_HI - SIG_LO);
  const stopBinScale = HIST_BINS / (STOP_HI - STOP_LO);
  const [sR, sG, sB] = sigF;
  const [lR, lG, lB] = lightF;
  const [aR, aG, aB] = axisF;
  const [kr, kg, kb] = LUMA;
  const dMask = fineShift ? 3 : 0;
  let seed = 0x9e3779b9;
  let clipped = 0, overWhite = 0, sum = 0, sumLight = 0;
  const pos = [];
  for (let c = 0; c < nCh; c++) pos.push(new Float32Array(width));

  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    // 1) positions and statistics for this scan line
    for (let x = 0; x < width; x++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const ri = (r << fineShift) | (seed & dMask);
      const gi = (g << fineShift) | ((seed >>> 2) & dMask);
      const bi = (b << fineShift) | ((seed >>> 4) & dMask);
      const ys = kr * sR[ri] + kg * sG[gi] + kb * sB[bi];
      const yl = kr * lR[ri] + kg * lG[gi] + kb * lB[bi];
      const lg = yl > 1e-9 ? Math.log2(yl) : -99;
      if (nCh === 1) {
        // Y' from the encoded channels, as a Y waveform does.
        pos[0][x] = posOf(stops ? lg : kr * aR[ri] + kg * aG[gi] + kb * aB[bi]);
      } else {
        pos[0][x] = posLut[0][ri];
        pos[1][x] = posLut[1][gi];
        pos[2][x] = posLut[2][bi];
      }
      let hb = ((ys - SIG_LO) * sigBinScale) | 0;
      sigHist[hb < 0 ? 0 : hb >= HIST_BINS ? HIST_BINS - 1 : hb]++;
      hb = ((lg - STOP_LO) * stopBinScale) | 0;
      lightHist[hb < 0 ? 0 : hb >= HIST_BINS ? HIST_BINS - 1 : hb]++;
      if (r >= 254 || g >= 254 || b >= 254) clipped++;
      if (yl > 1.01) overWhite++;
      sum += ys;
      sumLight += yl;
    }
    // 2) draw the scan line like a waveform monitor's beam: each pixel owns the
    //    segment from halfway to its left neighbour to halfway to its right one.
    for (let c = 0; c < nCh; c++) {
      const P = pos[c], bin = bins[c], D = diffs[c];
      for (let x = 0; x < width; x++) {
        const p = P[x], col = colMap[x];
        if (!lines) {
          const cc = p - 0.5;
          const k = cc < 0 ? 0 : Math.floor(cc), f = cc < 0 ? 0 : cc - k;
          if (k >= rows - 1) { bin[(rows - 1) * columns + col] += 1; continue; }
          bin[k * columns + col] += 1 - f;
          bin[(k + 1) * columns + col] += f;
          continue;
        }
        // stroke over [a, b] with weight 1: the two half-segments around this pixel
        const l = x > 0 ? (P[x - 1] + p) * 0.5 : p;
        const r = x < width - 1 ? (P[x + 1] + p) * 0.5 : p;
        for (let half = 0; half < 2; half++) {
          let a = half ? p : l, b = half ? r : p;
          if (a > b) { const t = a; a = b; b = t; }
          if (b - a < 0.05) {
            const cc = (a + b) * 0.5 - 0.5;
            const k = cc < 0 ? 0 : Math.floor(cc), f = cc < 0 ? 0 : cc - k;
            if (k >= rows - 1) { bin[(rows - 1) * columns + col] += 0.5; continue; }
            bin[k * columns + col] += 0.5 * (1 - f);
            bin[(k + 1) * columns + col] += 0.5 * f;
            continue;
          }
          const dens = 0.5 / (b - a);
          const k0 = Math.floor(a), k1 = Math.min(rows - 1, Math.floor(b));
          if (k0 === k1) { bin[k0 * columns + col] += 0.5; continue; }
          bin[k0 * columns + col] += dens * (k0 + 1 - a);
          bin[k1 * columns + col] += dens * (b - k1);
          if (k1 > k0 + 1) {
            D[(k0 + 1) * columns + col] += dens;
            D[k1 * columns + col] -= dens;
          }
        }
      }
    }
  }
  if (lines) {
    for (let c = 0; c < nCh; c++) {
      const D = diffs[c], bin = bins[c];
      for (let col = 0; col < columns; col++) {
        let run = 0;
        for (let k = 0; k < rows; k++) {
          run += D[k * columns + col];
          bin[k * columns + col] += run;
        }
      }
    }
  }

  const n = width * height;
  const pct = (hist, p, lo2, hi2) => {
    const target = p * n;
    let acc = 0;
    for (let k = 0; k < HIST_BINS; k++) {
      acc += hist[k];
      if (acc >= target) return lo2 + ((k + 0.5) * (hi2 - lo2)) / HIST_BINS;
    }
    return hi2;
  };
  const floorStops = pct(lightHist, 0.001, STOP_LO, STOP_HI);
  const peakStops = pct(lightHist, 0.999, STOP_LO, STOP_HI);
  const stats = {
    floor: pct(sigHist, 0.001, SIG_LO, SIG_HI),
    peak: pct(sigHist, 0.999, SIG_LO, SIG_HI),
    median: pct(sigHist, 0.5, SIG_LO, SIG_HI),
    mean: n ? sum / n : 0,
    meanLight: n ? sumLight / n : 0,
    floorStops,
    peakStops,
    rangeStops: peakStops - floorStops,
    clipped: n ? clipped / n : 0,
    overWhite: n ? overWhite / n : 0,
    pixels: n,
  };

  return { bins, columns, rows, samplesPerColumn: height * (width / columns), mode, axis, stopsRange, stats };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TRACE_COLORS = {
  luma: [[205, 240, 215]],
  rgb: [[255, 72, 64], [64, 255, 96], [72, 140, 255]],
};

/**
 * Convert accumulated bins to RGBA buffers (alpha = intensity), one per channel.
 * Like Resolve, brightness follows *density*: a lone stray sample is barely visible,
 * while many samples landing together build a bright line. No smoothing: each bin
 * maps to exactly one plot pixel.
 */
export function traceToRGBA(wf, gain = 1.5) {
  const { bins, columns, rows, samplesPerColumn } = wf;
  // Density relative to an even spread of a column's samples over all rows.
  const uniform = Math.max(1e-6, samplesPerColumn / rows);
  const g = (gain * 0.09) / uniform;
  const modeGain = wf.mode === 'overlay' ? 0.75 : 1;
  const colors = bins.length === 1 ? TRACE_COLORS.luma : TRACE_COLORS.rgb;
  const out = [];
  for (let ch = 0; ch < bins.length; ch++) {
    const b = bins[ch];
    const px = new Uint8ClampedArray(columns * rows * 4);
    const [cr, cg, cb] = colors[ch];
    for (let i = 0, j = 0; i < b.length; i++, j += 4) {
      const cnt = b[i];
      if (cnt <= 0) continue;
      // 1 - exp(-(d)^1.4): soft toe keeps sparse noise dim, dense traces saturate.
      const d = cnt * g;
      const a = modeGain * (1 - Math.exp(-Math.pow(d, 1.6)));
      if (a < 0.004) continue;
      const hot = a > 0.8 ? (a - 0.8) / 0.2 : 0;
      px[j] = cr + (255 - cr) * hot * 0.55;
      px[j + 1] = cg + (255 - cg) * hot * 0.55;
      px[j + 2] = cb + (255 - cb) * hot * 0.55;
      px[j + 3] = a * 255;
    }
    out.push(px);
  }
  return out;
}

export const SCOPE_FONT = 'ui-monospace, Menlo, Consolas, monospace';

/** Default legend font size (px) for a plot of w x h. */
export function scopeFontSize(w, h) {
  return Math.max(11, Math.round(Math.min(w / 40, Math.max(h / 28, w / 70))));
}

/**
 * Margins around the plot so the legend and stats never sit on the trace.
 * `measure` is a 2D context used to measure the labels.
 * Returns {font, left, top, bottom, right} in pixels.
 */
export function scopePadding(measure, w, h, axis, unit, o = {}) {
  const font = o.font || scopeFontSize(w, h);
  measure.font = `${font}px ${SCOPE_FONT}`;
  const labels = graticule(axis, unit, o).map((l) => l.label);
  const lw = Math.max(...labels.map((t) => measure.measureText(t).width));
  const even = (v) => Math.ceil(v / 2) * 2;
  return {
    font,
    left: even(lw + font * 1.1),
    top: even(o.stats ? font * 3.0 : font * 1.0),
    bottom: even(font * 1.7),
    right: even(font * 0.6),
  };
}

/**
 * Draw a scope into ctx. (x, y, w, h) is the plot area; the trace maps exactly onto it.
 * With opts.pad (from scopePadding) the legend goes in a gutter to the left, the stats
 * in a strip above and the caption in a strip below, outside the plot.
 * opts: {gain, background, unit, format, peakNits, displayTF, blackLight, statsText, caption, pad}
 */
export function drawScope(ctx, wf, x, y, w, h, opts = {}) {
  const { gain = 1.5, background = '#0b0d0e', blackLight = null, statsText = '', caption = '', pad = null } = opts;
  const { lo, hi } = scaleRange(wf.axis, wf.stopsRange);
  const panels = wf.mode === 'parade' ? 3 : 1;
  const font = pad ? pad.font : scopeFontSize(w, h);
  const P = pad || { left: 0, top: 0, bottom: 0, right: 0 };

  ctx.save();
  ctx.beginPath();
  ctx.rect(x - P.left, y - P.top, w + P.left + P.right, h + P.top + P.bottom);
  ctx.clip();
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(x, y, w, h);
  }

  const valueToY = (v) => y + ((hi - v) / (hi - lo)) * h;
  const lines = graticule(wf.axis, opts.unit, { ...opts, stopsRange: wf.stopsRange });
  const peakValue = wf.axis === 'stops' ? 0 : 1;

  // Graticule (with a short tick into the gutter when there is one)
  ctx.lineWidth = Math.max(1, Math.round(h / 400));
  const tick = pad ? font * 0.35 : 0;
  for (const ln of lines) {
    const ly = Math.round(valueToY(ln.value)) + 0.5;
    ctx.strokeStyle = ln.value === peakValue ? 'rgba(240,190,90,0.75)'
      : ln.major ? 'rgba(200,170,90,0.42)' : 'rgba(200,170,90,0.22)';
    ctx.beginPath();
    ctx.moveTo(x - tick, ly);
    ctx.lineTo(x + w, ly);
    ctx.stroke();
  }
  if (pad) {
    // Ruler like Resolve: a line down the plot's left edge with minor ticks, and ticks along the bottom.
    ctx.strokeStyle = 'rgba(200,170,90,0.55)';
    ctx.beginPath();
    ctx.moveTo(x - 0.5, y);
    ctx.lineTo(x - 0.5, y + h);
    for (const v of minorTicks(wf.axis, opts.unit, { ...opts, stopsRange: wf.stopsRange })) {
      if (v > hi || v < lo) continue;
      const ty = Math.round(valueToY(v)) + 0.5;
      ctx.moveTo(x - tick * 0.6, ty);
      ctx.lineTo(x, ty);
    }
    ctx.moveTo(x, y + h + 0.5);
    ctx.lineTo(x + w, y + h + 0.5);
    for (let k = 0; k <= 40; k++) {
      const tx = Math.round(x + (k * (w - 1)) / 40) + 0.5;
      ctx.moveTo(tx, y + h);
      ctx.lineTo(tx, y + h + (k % 4 === 0 ? tick : tick * 0.5));
    }
    ctx.stroke();
  }
  // Measured projector black floor (light, so only meaningful on light-based axes).
  if (blackLight && wf.axis !== 'sdr') {
    const ly = Math.round(valueToY(lightToAxis(blackLight, wf.axis, opts))) + 0.5;
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
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // Pixel-exact: the trace is accumulated at the plot's own resolution.
  ctx.imageSmoothingEnabled = wf.columns < panelW - 1 || wf.rows < h - 1;
  ctx.globalCompositeOperation = 'lighter';
  for (let ch = 0; ch < rgba.length; ch++) {
    tctx.putImageData(new ImageData(rgba[ch], wf.columns, wf.rows), 0, 0);
    const px = panels === 3 ? x + ch * panelW : x;
    ctx.drawImage(tmp, px, y, panelW, h);
  }
  ctx.restore();

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

  // Legend
  ctx.font = `${font}px ${SCOPE_FONT}`;
  ctx.textBaseline = 'middle';
  if (pad) {
    // In the gutter, right-aligned against the plot.
    ctx.textAlign = 'right';
    for (const ln of lines) {
      if (!ln.major && h < 260 && ln.value !== peakValue) continue;
      ctx.fillStyle = ln.value === peakValue ? 'rgba(250,205,120,0.95)' : 'rgba(225,200,140,0.9)';
      ctx.fillText(ln.label, x - tick - font * 0.3, valueToY(ln.value));
    }
  } else {
    // No room outside: draw on a dark backing inside the plot.
    ctx.textAlign = 'left';
    for (const ln of lines) {
      if (!ln.major && h < 260 && ln.value !== peakValue) continue;
      const ty = Math.min(Math.max(valueToY(ln.value), y + font * 0.6), y + h - font * 0.6);
      const tw = ctx.measureText(ln.label).width;
      ctx.fillStyle = 'rgba(8,10,11,0.72)';
      ctx.fillRect(x + font * 0.2, ty - font * 0.55, tw + font * 0.4, font * 1.1);
      ctx.fillStyle = ln.value === peakValue ? 'rgba(250,205,120,0.95)' : 'rgba(225,200,140,0.9)';
      ctx.fillText(ln.label, x + font * 0.4, ty);
    }
  }
  ctx.textAlign = 'right';
  if (caption) {
    ctx.textBaseline = pad ? 'middle' : 'bottom';
    ctx.fillStyle = 'rgba(200,200,200,0.6)';
    ctx.fillText(caption, x + w - font * 0.2, pad ? y + h + P.bottom / 2 : y + h - font * 0.3);
  }
  if (statsText) {
    const lines2 = Array.isArray(statsText) ? statsText : [statsText];
    ctx.textBaseline = 'top';
    if (pad) {
      ctx.fillStyle = 'rgba(235,235,235,0.92)';
      const top = y - P.top + (P.top - lines2.length * font * 1.2) / 2;
      lines2.forEach((t, i) => ctx.fillText(t, x + w - font * 0.2, top + i * font * 1.2));
    } else {
      const tw = Math.max(...lines2.map((t) => ctx.measureText(t).width));
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + w - tw - font, y, tw + font, font * (0.8 + lines2.length * 1.25));
      ctx.fillStyle = 'rgba(235,235,235,0.9)';
      lines2.forEach((t, i) => ctx.fillText(t, x + w - font * 0.5, y + font * 0.4 + i * font * 1.25));
    }
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
