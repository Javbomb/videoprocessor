// Run with: node --test waveform-app/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFERS, buildLUTs, computeWaveform, measureRegion, scaleRange } from '../js/waveform.js';

const solid = (w, h, r, g, b) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return d;
};

test('transfer functions round-trip', () => {
  for (const [key, tf] of Object.entries(TRANSFERS)) {
    for (const v of [0, 0.02, 0.18, 0.5, 0.9, 1]) {
      assert.ok(Math.abs(tf.fromLinear(tf.toLinear(v)) - v) < 1e-6, `${key} @ ${v}`);
    }
  }
});

test('uncalibrated LUT shows raw code values', () => {
  const luts = buildLUTs();
  assert.equal(luts.calibrated, false);
  assert.equal(luts.sig[0][255], 1);
  assert.ok(Math.abs(luts.sig[1][128] - 128 / 255) < 1e-6);
});

test('reference white maps to 100% signal and 0 stops', () => {
  const white = measureRegion(solid(10, 10, 200, 190, 210));
  const luts = buildLUTs({ white, perChannel: true });
  assert.ok(Math.abs(luts.sig[0][200] - 1) < 1e-4);
  assert.ok(Math.abs(luts.sig[1][190] - 1) < 1e-4);
  assert.ok(Math.abs(luts.sig[2][210] - 1) < 1e-4);
  assert.ok(Math.abs(luts.light[0][200] - 1) < 1e-4);
});

test('black reference maps to 0% signal', () => {
  const white = measureRegion(solid(4, 4, 220, 220, 220));
  const black = measureRegion(solid(4, 4, 20, 20, 20));
  const luts = buildLUTs({ white, black });
  assert.ok(Math.abs(luts.sig[0][20]) < 1e-4);
  assert.ok(luts.blackLight > 0 && luts.blackLight < 0.05);
});

test('half-light grey reads as signal 0.5^(1/gamma) after calibration', () => {
  // A camera pixel with half the linear light of white should be signal 0.5^(1/2.4) on a 2.4 display.
  const white = measureRegion(solid(4, 4, 255, 255, 255));
  const luts = buildLUTs({ white, cameraTF: 'linear', displayTF: 'g24' });
  const v = luts.sig[0][Math.round(0.5 * 255)];
  assert.ok(Math.abs(v - Math.pow(128 / 255, 1 / 2.4)) < 1e-4);
});

test('measureRegion reports camera clipping', () => {
  const m = measureRegion(solid(10, 10, 255, 255, 255));
  assert.equal(m.clipped, 1);
  assert.equal(m.codeMean[0], 255);
});

test('flat field lands in a single waveform row per column', () => {
  const w = 64, h = 32;
  const luts = buildLUTs();
  const wf = computeWaveform(solid(w, h, 128, 128, 128), w, h, { mode: 'luma', scale: 'code', columns: 32, rows: 100, luts });
  const b = wf.bins[0];
  const { lo, hi } = scaleRange('code');
  const expectedRow = Math.round((hi - 128 / 255) * (99 / (hi - lo)));
  for (let col = 0; col < 32; col++) {
    assert.equal(b[expectedRow * 32 + col], h * 2, `col ${col}`);
  }
  assert.ok(Math.abs(wf.stats.peak - 128 / 255) < 0.002);
  assert.ok(Math.abs(wf.stats.floor - 128 / 255) < 0.002);
});

test('horizontal ramp produces a diagonal and full-range stats', () => {
  const w = 256, h = 8;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = x; d[i + 3] = 255;
  }
  const wf = computeWaveform(d, w, h, { mode: 'parade', scale: 'percent', columns: 256, rows: 256, luts: buildLUTs() });
  assert.equal(wf.bins.length, 3);
  // Each column's samples live in exactly one row; row decreases as x increases.
  const rowOf = (col) => { for (let r = 0; r < 256; r++) if (wf.bins[1][r * 256 + col]) return r; return -1; };
  assert.ok(rowOf(0) > rowOf(128) && rowOf(128) > rowOf(255));
  assert.ok(wf.stats.floor < 0.01 && wf.stats.peak > 0.99);
});

test('stops scale accumulates without overflow', () => {
  const white = measureRegion(solid(4, 4, 240, 240, 240));
  const luts = buildLUTs({ white });
  const wf = computeWaveform(solid(16, 16, 0, 0, 0), 16, 16, { mode: 'luma', scale: 'stops', columns: 16, rows: 50, luts, stopsRange: 10 });
  const total = wf.bins[0].reduce((a, b) => a + b, 0);
  assert.equal(total, 256);
});
