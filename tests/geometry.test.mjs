// Run with: node --test waveform-app/tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { squareToQuad, mapUV, warpQuad, detectPicture, insetQuad, isAxisAligned, quadAspect } from '../js/geometry.js';

const W = 512, H = 384;
const QUAD = [[70, 66], [440, 58], [445, 290], [64, 296]]; // keystoned, in pixels

function inQuad(q, x, y) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    const c = Math.sign((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1));
    if (c && s && c !== s) return false;
    if (c) s = c;
  }
  return true;
}

/** Render a fake photo: dark room, a projected picture in QUAD; `content(u, v)` gives 0..255. */
function photo(content) {
  const d = new Uint8ClampedArray(W * H * 4);
  const Hq = squareToQuad(QUAD);
  // invert mapping numerically per pixel via a coarse search is slow; instead forward-map a dense grid.
  for (let i = 0; i < W * H; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 6; d[i * 4 + 3] = 255; }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inQuad(QUAD, x + 0.5, y + 0.5)) continue;
      // approximate (u, v) by solving with a few Newton steps from the centre
      let u = 0.5, v = 0.5;
      for (let k = 0; k < 8; k++) {
        const [px, py] = mapUV(Hq, u, v);
        const e = 1e-4;
        const [ax, ay] = mapUV(Hq, u + e, v), [bx, by] = mapUV(Hq, u, v + e);
        const j11 = (ax - px) / e, j12 = (bx - px) / e, j21 = (ay - py) / e, j22 = (by - py) / e;
        const det = j11 * j22 - j12 * j21;
        const rx = x + 0.5 - px, ry = y + 0.5 - py;
        u += (j22 * rx - j12 * ry) / det;
        v += (-j21 * rx + j11 * ry) / det;
      }
      const c = content(u, v);
      d[(y * W + x) * 4] = d[(y * W + x) * 4 + 1] = d[(y * W + x) * 4 + 2] = c;
    }
  }
  return d;
}

const maxErr = (q, truth) => Math.max(...q.map((p, i) => Math.hypot(p[0] * W - truth[i][0], p[1] * H - truth[i][1])));

test('square-to-quad maps corners', () => {
  const Hq = squareToQuad(QUAD);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const [x, y] = mapUV(Hq, u, v);
    assert.ok(Math.hypot(x - QUAD[i][0], y - QUAD[i][1]) < 1e-6);
  });
  assert.ok(isAxisAligned([[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]]));
  assert.ok(!isAxisAligned(QUAD));
  assert.ok(Math.abs(quadAspect([[0, 0], [16, 0], [16, 9], [0, 9]]) - 16 / 9) < 1e-9);
});

test('warp rectifies a quad', () => {
  const src = photo((u) => (u < 0.5 ? 40 : 220));
  const dst = new Uint8ClampedArray(64 * 36 * 4);
  warpQuad(src, W, H, QUAD, dst, 64, 36);
  assert.ok(dst[(18 * 64 + 8) * 4] < 60);
  assert.ok(dst[(18 * 64 + 56) * 4] > 200);
});

test('detects a keystoned white frame', () => {
  const r = detectPicture(photo(() => 230), W, H);
  assert.ok(r && r.ok);
  assert.ok(maxErr(r.quad, insetQuad(QUAD.map(([x, y]) => [x / W, y / H]), 0.006).map(([x, y]) => [x * W, y * H])) < 2);
});

test('excludes pillarbox bars', () => {
  const img = photo((u, v) => (u < 0.125 || u > 0.875 ? 8 : 120 + 80 * Math.sin(v * 9)));
  const Hq = squareToQuad(QUAD);
  const truth = [[0.125, 0], [0.875, 0], [0.875, 1], [0.125, 1]].map(([u, v]) => mapUV(Hq, u, v));
  // Blind: the bars are as dark as the room, so the lit picture itself is found.
  const r = detectPicture(img, W, H);
  assert.ok(r && r.ok);
  assert.ok(maxErr(r.quad, truth) < 4, 'corner error ' + maxErr(r.quad, truth));
  // With the raster known (from a white frame), the bars are trimmed off.
  const r2 = detectPicture(img, W, H, { raster: QUAD.map(([x, y]) => [x / W, y / H]) });
  assert.ok(r2 && r2.ok && r2.trimmed);
  assert.ok(maxErr(r2.quad, truth) < 4, 'corner error (raster) ' + maxErr(r2.quad, truth));
});

test('uses a known raster and finds nothing in an empty room', () => {
  const raster = QUAD.map(([x, y]) => [x / W, y / H]);
  const r = detectPicture(photo((u) => 30 + u * 150), W, H, { raster });
  assert.ok(r && r.ok && !r.trimmed);
  const blank = new Uint8ClampedArray(W * H * 4).fill(5);
  assert.equal(detectPicture(blank, W, H), null);
});
