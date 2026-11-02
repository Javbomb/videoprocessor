// Picture-area geometry: automatic detection of the projected picture in a
// photo, perspective (keystone) correction and helpers. No DOM dependencies.
//
// A quad is [[x, y] x4] in normalized photo coordinates (0..1), ordered
// top-left, top-right, bottom-right, bottom-left.

export const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function rectToQuad({ x, y, w, h }) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** True when the quad is an axis-aligned rectangle (no warp needed). */
export function isAxisAligned(q, eps = 1e-4) {
  return Math.abs(q[0][1] - q[1][1]) < eps && Math.abs(q[3][1] - q[2][1]) < eps &&
    Math.abs(q[0][0] - q[3][0]) < eps && Math.abs(q[1][0] - q[2][0]) < eps;
}

export function quadBounds(q) {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Approximate aspect (w/h) of the real rectangle, from a quad in pixel units. */
export function quadAspect(qPx) {
  const w = (dist(qPx[0], qPx[1]) + dist(qPx[3], qPx[2])) / 2;
  const h = (dist(qPx[0], qPx[3]) + dist(qPx[1], qPx[2])) / 2;
  return w / Math.max(h, 1e-9);
}

/**
 * Homography mapping the unit square (u, v) to a quad (Heckbert's square-to-quad).
 * Returns [a, b, c, d, e, f, g, h]: x = (a u + b v + c) / (g u + h v + 1), y = (d u + e v + f) / (...)
 */
export function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

export function mapUV(H, u, v) {
  const [a, b, c, d, e, f, g, h] = H;
  const w = g * u + h * v + 1;
  return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
}

/** Shrink a quad by `f` (fraction of its own width/height) on every side, in perspective. */
export function insetQuad(q, f) {
  const H = squareToQuad(q);
  return [[f, f], [1 - f, f], [1 - f, 1 - f], [f, 1 - f]].map(([u, v]) => mapUV(H, u, v));
}

/**
 * Perspective-warp `qPx` (quad in source pixel coordinates) of an RGBA image to a
 * dw x dh rectangle, with bilinear sampling.
 */
export function warpQuad(src, sw, sh, qPx, dst, dw, dh) {
  const [a, b, c, d, e, f, g, h] = squareToQuad(qPx);
  const maxX = sw - 1.001, maxY = sh - 1.001;
  for (let y = 0; y < dh; y++) {
    const v = (y + 0.5) / dh;
    // numerators/denominator are linear in u along a row
    let nx = b * v + c + a * (0.5 / dw), ny = e * v + f + d * (0.5 / dw), nw = h * v + 1 + g * (0.5 / dw);
    const ax = a / dw, ay = d / dw, aw = g / dw;
    let o = y * dw * 4;
    for (let x = 0; x < dw; x++, o += 4) {
      let sx = nx / nw - 0.5, sy = ny / nw - 0.5;
      nx += ax; ny += ay; nw += aw;
      if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
      if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i01 = i00 + 4, i10 = i00 + sw * 4, i11 = i10 + 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      dst[o] = src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11;
      dst[o + 1] = src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11;
      dst[o + 2] = src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11;
      dst[o + 3] = 255;
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const SRGB_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Robust line fit. pts: [[t, s]] fits s = m t + k; returns {m, k} or null. */
function fitLine(pts) {
  let use = pts;
  let m = 0, k = 0;
  for (let iter = 0; iter < 4; iter++) {
    if (use.length < 6) return null;
    let st = 0, ss = 0, stt = 0, sts = 0;
    for (const [t, s] of use) { st += t; ss += s; stt += t * t; sts += t * s; }
    const n = use.length;
    const den = n * stt - st * st;
    if (Math.abs(den) < 1e-9) return null;
    m = (n * sts - st * ss) / den;
    k = (ss - m * st) / n;
    const res = pts.map(([t, s]) => Math.abs(s - (m * t + k)));
    const sorted = [...res].sort((x, y) => x - y);
    const tol = Math.max(1.5, 2.5 * sorted[Math.floor(sorted.length / 2)]);
    use = pts.filter((_, i) => res[i] <= tol);
  }
  return { m, k };
}

function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0, bestSize = 0, cur = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i]) continue;
    cur++;
    let sp = 0, size = 0;
    stack[sp++] = i;
    label[i] = cur;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
      if (p >= w && mask[p - w] && !label[p - w]) { label[p - w] = cur; stack[sp++] = p - w; }
      if (p < w * (h - 1) && mask[p + w] && !label[p + w]) { label[p + w] = cur; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  return { label, id: best, size: bestSize };
}

/** Morphological close (dilate then erode) with a (2r+1)^2 square, separable. */
function close(mask, w, h, r) {
  const run = (src, dilate) => {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          const s = src[y * w + xx];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          const s = tmp[yy * w + x];
          if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  return run(run(mask, true), false);
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function pointInQuad(q, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

/** Fit a quad (pixel coords) to a component: extreme points, then per-side line fits. */
function fitQuad(label, id, w, h) {
  const rowL = new Int32Array(h).fill(-1), rowR = new Int32Array(h).fill(-1);
  const colT = new Int32Array(w).fill(-1), colB = new Int32Array(w).fill(-1);
  let tl = null, tr = null, br = null, bl = null;
  let sTL = Infinity, sTR = -Infinity, sBR = -Infinity, sBL = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== id) continue;
      if (rowL[y] < 0) rowL[y] = x;
      rowR[y] = x;
      if (colT[x] < 0) colT[x] = y;
      colB[x] = y;
      const s = x + y, dd = x - y;
      if (s < sTL) { sTL = s; tl = [x, y]; }
      if (s > sBR) { sBR = s; br = [x, y]; }
      if (dd > sTR) { sTR = dd; tr = [x, y]; }
      if (dd < sBL) { sBL = dd; bl = [x, y]; }
    }
  }
  if (!tl) return null;
  const pick = (from, to, arr, edgeOffset) => {
    const pts = [];
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const margin = (hi - lo) * 0.1;
    for (let t = Math.ceil(lo + margin); t <= hi - margin; t++) if (arr[t] >= 0) pts.push([t, arr[t] + edgeOffset]);
    return fitLine(pts);
  };
  // +0.5 puts the line on pixel edges rather than centres.
  const top = pick(tl[0], tr[0], colT, 0);
  const bottom = pick(bl[0], br[0], colB, 1);
  const left = pick(tl[1], bl[1], rowL, 0);
  const right = pick(tr[1], br[1], rowR, 1);
  if (!top || !bottom || !left || !right) return [tl, tr, [br[0] + 1, br[1] + 1], bl];
  // y = m x + k (top/bottom) meets x = m y + k (left/right)
  const meet = (hz, vt) => {
    const y = (hz.m * vt.k + hz.k) / (1 - hz.m * vt.m);
    return [vt.m * y + vt.k, y];
  };
  return [meet(top, left), meet(top, right), meet(bottom, right), meet(bottom, left)];
}

/** Median brightness ratio (in stops) across each side of the quad: inside vs outside. */
function edgeContrast(lin, w, h, q) {
  const d = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  const sample = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return null;
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += lin[(yi + dy) * w + xi + dx];
    return s / 9;
  };
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const { a, b, nx, ny } = side(q, i);
    const ratios = [];
    for (let k = 1; k < 24; k++) {
      const t = k / 24;
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      const vin = sample(px + nx * d, py + ny * d), vout = sample(px - nx * d, py - ny * d);
      if (vin == null || vout == null) continue;
      ratios.push(Math.log2((vin + 1e-4) / (vout + 1e-4)));
    }
    if (ratios.length < 5) return { min: 0, sides: [] };
    ratios.sort((x, y) => x - y);
    sides.push(ratios[Math.floor(ratios.length / 2)]);
  }
  return { min: Math.min(...sides), sides };
}

/** Side i of a quad with its inward unit normal. */
function side(q, i) {
  const a = q[i], b = q[(i + 1) % 4];
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  let nx = -(b[1] - a[1]), ny = b[0] - a[0];
  const len = Math.hypot(nx, ny) || 1;
  nx /= len; ny /= len;
  if ((cx - (a[0] + b[0]) / 2) * nx + (cy - (a[1] + b[1]) / 2) * ny < 0) { nx = -nx; ny = -ny; }
  return { a, b, nx, ny };
}

function bilinear(lin, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return null;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (lin[i] * (1 - fx) + lin[i + 1] * fx) * (1 - fy) + (lin[i + w] * (1 - fx) + lin[i + w + 1] * fx) * fy;
}

/** Total-least-squares line through points with outlier rejection: {px, py, dx, dy}. */
function fitLineTLS(pts) {
  let use = pts;
  let line = null;
  for (let iter = 0; iter < 4; iter++) {
    if (use.length < 5) return line;
    let mx = 0, my = 0;
    for (const [x, y] of use) { mx += x; my += y; }
    mx /= use.length; my /= use.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of use) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    line = { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
    const res = pts.map(([x, y]) => Math.abs((x - mx) * -line.dy + (y - my) * line.dx));
    const sorted = [...res].sort((p, q) => p - q);
    const tol = Math.max(0.6, 3 * sorted[Math.floor(sorted.length / 2)]);
    use = pts.filter((_, i) => res[i] <= tol);
  }
  return line;
}

function intersect(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
  return [l1.px + l1.dx * t, l1.py + l1.dy * t];
}

/**
 * Move every side of q onto the 50% light crossing of the edge it sits on (sub-pixel).
 * Sides without a clear step keep their position.
 */
function refineQuad(lin, w, h, q) {
  const R = Math.max(3, Math.min(w, h) * 0.02);
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const { a, b, nx, ny } = side(q, i);
    const pts = [];
    for (let k = 2; k < 39; k++) {
      const t = k / 40;
      const bx = a[0] + (b[0] - a[0]) * t, by = a[1] + (b[1] - a[1]) * t;
      const prof = [];
      let ok = true;
      for (let s = -R; s <= R + 1e-9; s += 0.25) {
        const v = bilinear(lin, w, h, bx + nx * s, by + ny * s);
        if (v == null) { ok = false; break; }
        prof.push(v);
      }
      if (!ok) continue;
      const q4 = Math.floor(prof.length / 4);
      let vout = 0, vin = 0;
      for (let j = 0; j < q4; j++) { vout += prof[j]; vin += prof[prof.length - 1 - j]; }
      vout /= q4; vin /= q4;
      if (vin < vout * 1.6) continue;
      const mid = (vin + vout) / 2;
      // Crossing nearest to the current edge position (centre of the profile).
      const c = Math.floor(prof.length / 2);
      let found = null;
      for (let off = 0; off < c && found == null; off++) {
        for (const j of [c - off, c + off]) {
          if (j <= 0 || j >= prof.length) continue;
          if (prof[j - 1] < mid && prof[j] >= mid) {
            found = -R + (j - 1 + (mid - prof[j - 1]) / (prof[j] - prof[j - 1])) * 0.25;
            break;
          }
        }
      }
      if (found != null) pts.push([bx + nx * found, by + ny * found]);
    }
    const ln = pts.length >= 8 ? fitLineTLS(pts) : null;
    lines.push(ln || { px: a[0], py: a[1], dx: (b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]), dy: (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]) });
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return q;
    out.push(p);
  }
  // Reject a refinement that moved a corner implausibly far.
  const diag = Math.hypot(w, h);
  if (out.some((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > diag * 0.05)) return q;
  return out;
}

/** Find the outer lit area: the largest clean, high-contrast rectangle. Pixel-space quad. */
function findRaster(lum, lin, w, h) {
  const n = w * h;
  const ring = [];
  const bw = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < bw || y < bw || x >= w - bw || y >= h - bw) ring.push(lum[y * w + x]);
    }
  }
  ring.sort((a, b) => a - b);
  const room = ring[Math.floor(ring.length * 0.5)];
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[lum[i]]++;
  let acc = 0, bright = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { bright = v; break; } }
  if (bright - room < 12) return null;

  const lr = SRGB_LIN[room], lb = SRGB_LIN[bright];
  const toCode = (l) => {
    let v = 0;
    while (v < 255 && SRGB_LIN[v] < l) v++;
    return v;
  };
  const cands = [];
  const seen = new Set();
  for (const f of [0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5]) {
    const t = Math.max(room + 3, toCode(lr + (lb - lr) * f));
    if (seen.has(t)) continue;
    seen.add(t);
    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = lum[i] >= t ? 1 : 0;
    mask = close(mask, w, h, Math.max(1, Math.round(Math.min(w, h) / 150)));
    const { label, id, size } = largestComponent(mask, w, h);
    if (size < n * 0.03) continue;
    const q = fitQuad(label, id, w, h);
    if (!q) continue;
    const area = quadArea(q);
    if (area < n * 0.03) continue;
    let inside = 0, total = 0;
    const qb = quadBounds(q);
    const step = Math.max(1, Math.round(Math.sqrt(area / 4000)));
    for (let y = Math.max(0, Math.floor(qb.y)); y < Math.min(h, qb.y + qb.h); y += step) {
      for (let x = Math.max(0, Math.floor(qb.x)); x < Math.min(w, qb.x + qb.w); x += step) {
        if (!pointInQuad(q, x + 0.5, y + 0.5)) continue;
        total++;
        if (label[y * w + x] === id) inside++;
      }
    }
    const fill = total ? inside / total : 0;
    const touches = q.some(([x, y]) => x < 1 || y < 1 || x > w - 1 || y > h - 1);
    const contrast = edgeContrast(lin, w, h, q).min;
    cands.push({ q, area, fill, contrast, touches, valid: fill >= 0.9 && contrast >= 1 && !touches });
  }
  if (!cands.length) return null;
  const valid = cands.filter((c) => c.valid);
  if (valid.length) return { ...valid.reduce((a, b) => (b.area > a.area ? b : a)), ok: true };
  const best = cands.reduce((a, b) => (b.fill * Math.min(b.contrast, 3) > a.fill * Math.min(a.contrast, 3) ? b : a));
  return { ...best, ok: false };
}

/**
 * Inside a raster quad, strip uniform dark bands that appear on BOTH opposite sides
 * (letterbox / pillarbox bars, or unlit screen margin). Returns a pixel-space quad.
 */
function trimBars(data, lin, w, h, raster) {
  const RW = 320;
  const RH = Math.max(40, Math.round(RW / Math.max(0.3, quadAspect(raster))));
  const rect = new Uint8ClampedArray(RW * RH * 4);
  warpQuad(data, w, h, raster, rect, RW, RH);
  const L = new Float32Array(RW * RH);
  for (let i = 0; i < RW * RH; i++) L[i] = SRGB_LIN[Math.max(rect[i * 4], rect[i * 4 + 1], rect[i * 4 + 2])];
  const sorted = Float32Array.from(L).sort();
  const dark = sorted[Math.floor(sorted.length * 0.01)];
  const bright = sorted[Math.floor(sorted.length * 0.95)];
  // A bar is near the darkest level and far below the picture (at least ~4 stops).
  const limit = Math.min(dark * 2 + (bright - dark) * 0.02, bright / 16);
  const p98 = (vals) => { vals.sort((a, b) => a - b); return vals[Math.floor(vals.length * 0.98)]; };
  const colMax = new Float32Array(RW), rowMax = new Float32Array(RH);
  for (let x = 0; x < RW; x++) { const v = []; for (let y = 0; y < RH; y++) v.push(L[y * RW + x]); colMax[x] = p98(v); }
  for (let y = 0; y < RH; y++) rowMax[y] = p98(Array.from(L.subarray(y * RW, (y + 1) * RW)));
  const run = (arr, from, dir) => {
    let k = 0;
    for (let i = from; i >= 0 && i < arr.length && arr[i] < limit; i += dir) k++;
    return k;
  };
  const minBand = 0.006;
  let l = run(colMax, 0, 1) / RW, r = run(colMax, RW - 1, -1) / RW;
  let t = run(rowMax, 0, 1) / RH, b = run(rowMax, RH - 1, -1) / RH;
  if (!(l > minBand && r > minBand) || l + r > 0.8) { l = 0; r = 0; }
  if (!(t > minBand && b > minBand) || t + b > 0.8) { t = 0; b = 0; }
  if (!l && !r && !t && !b) return { quad: raster, trimmed: false, lr: false, tb: false };
  const H = squareToQuad(raster);
  return { quad: [[l, t], [1 - r, t], [1 - r, 1 - b], [l, 1 - b]].map(([u, v]) => mapUV(H, u, v)), trimmed: true, lr: !!(l || r), tb: !!(t || b) };
}

/**
 * Find the projected picture in a photo.
 * @param {Uint8ClampedArray} data RGBA of a downscaled photo (~400-640 px wide)
 * @param {object} [opts] {raster}: a known projector raster (normalized quad), e.g. found
 *        on the white calibration frame. Then only bars inside it are looked for.
 * @returns {{quad, raster, ok, contrast, fill, trimmed} | null}  normalized quads; `quad` is
 *          inset slightly past the soft projected edge.
 */
export function detectPicture(data, w, h, opts = {}) {
  const n = w * h;
  const lum = new Uint8Array(n);
  const lin = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const m = Math.max(data[j], data[j + 1], data[j + 2]);
    lum[i] = m;
    lin[i] = SRGB_LIN[m];
  }
  let raster, info = { ok: true, contrast: null, fill: null };
  if (opts.raster) {
    raster = opts.raster.map(([x, y]) => [x * w, y * h]);
  } else {
    const r = findRaster(lum, lin, w, h);
    if (!r || !r.ok) {
      // Maybe a frame grab / screenshot: the picture fills the frame apart from
      // letterbox OR pillarbox bars (a room photo would be dark on all four sides).
      const full = [[0, 0], [w, 0], [w, h], [0, h]];
      const fb = trimBars(data, lin, w, h, full);
      if (fb.trimmed && fb.lr !== fb.tb) {
        const norm = (q) => q.map(([x, y]) => [x / w, y / h]);
        return { quad: insetQuad(norm(fb.quad), 0.002), raster: norm(full), trimmed: true, ok: true, frame: true };
      }
      if (!r) return null;
    }
    raster = refineQuad(lin, w, h, r.q);
    info = { ok: r.ok, contrast: r.contrast, fill: r.fill };
  }
  const { quad: trimmedQ, trimmed } = trimBars(data, lin, w, h, raster);
  const pic = trimmed ? refineQuad(lin, w, h, trimmedQ) : trimmedQ;
  const norm = (q) => q.map(([x, y]) => [x / w, y / h]);
  return { quad: insetQuad(norm(pic), 0.006), raster: norm(raster), trimmed, ...info };
}
