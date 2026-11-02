// Run with: node --test waveform-app/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSFERS, buildLUTs, computeWaveform, measureRegion, scaleRange, pqEncode, pqDecode, graticule, formatStats, axisFor } from '../js/waveform.js';

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
  const wf = computeWaveform(solid(w, h, 128, 128, 128), w, h, { mode: 'luma', axis: 'sdr', columns: 32, rows: 100, luts });
  const b = wf.bins[0];
  const { lo, hi } = scaleRange('sdr');
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
  const wf = computeWaveform(d, w, h, { mode: 'parade', axis: 'sdr', columns: 256, rows: 256, luts: buildLUTs() });
  assert.equal(wf.bins.length, 3);
  // Each column's samples live in exactly one row; row decreases as x increases.
  const rowOf = (col) => { for (let r = 0; r < 256; r++) if (wf.bins[1][r * 256 + col]) return r; return -1; };
  assert.ok(rowOf(0) > rowOf(128) && rowOf(128) > rowOf(255));
  assert.ok(wf.stats.floor < 0.01 && wf.stats.peak > 0.99);
});

test('stops scale accumulates without overflow', () => {
  const white = measureRegion(solid(4, 4, 240, 240, 240));
  const luts = buildLUTs({ white });
  const wf = computeWaveform(solid(16, 16, 0, 0, 0), 16, 16, { mode: 'luma', axis: 'stops', columns: 16, rows: 50, luts, stopsRange: 10 });
  const total = wf.bins[0].reduce((a, b) => a + b, 0);
  assert.equal(total, 256);
});

test('PQ matches ST 2084 reference points', () => {
  assert.ok(Math.abs(pqEncode(10000) - 1) < 1e-9);
  assert.ok(Math.abs(pqEncode(100) - 0.5081) < 1e-3);
  assert.ok(Math.abs(pqEncode(1000) - 0.7518) < 1e-3);
  assert.equal(pqEncode(0), 0);
  for (const n of [0.05, 1, 100, 1000, 4000]) assert.ok(Math.abs(pqDecode(pqEncode(n)) - n) / n < 1e-6);
});

test('HDR: reference white sits at the top of the PQ axis, half light lower', () => {
  const white = measureRegion(solid(4, 4, 255, 255, 255));
  const luts = buildLUTs({ white, cameraTF: 'linear', peakNits: 1000 });
  assert.ok(Math.abs(luts.pqFine[0][1023] - 1) < 1e-4);
  // 128/255 linear ~ 502 nits -> PQ(502)/PQ(1000)
  const mid = luts.pqFine[1][128 * 4 + 1];
  assert.ok(Math.abs(mid - pqEncode(1000 * 128 / 255) / pqEncode(1000)) < 0.01);
  const wf = computeWaveform(solid(8, 8, 255, 255, 255), 8, 8, { mode: 'overlay', axis: 'pq', columns: 8, rows: 111, luts });
  const { lo, hi } = scaleRange('pq');
  const topRow = Math.round((hi - 1) * (110 / (hi - lo)));
  assert.equal(wf.bins[0][topRow * 8], 8);
});

test('legends: top line is the chosen peak', () => {
  const hdr = graticule('pq', 'nits', { peakNits: 1000 });
  const top = hdr[hdr.length - 1];
  assert.equal(top.value, 1);
  assert.equal(top.label, '1000 nits');
  assert.ok(hdr.some((l) => l.label === '100'));
  assert.equal(graticule('pq', 'nits', { peakNits: 10000 }).at(-1).label, '10000 nits');
  const pqCode = graticule('pq', 'code', { peakNits: 1000 }).at(-1);
  assert.equal(pqCode.label, '769 (PQ)');
  const ire = graticule('sdr', 'percent', {});
  assert.equal(ire.at(-1).label, '100 IRE');
  const sdrNits = graticule('sdr', 'nits', { peakNits: 100, displayTF: 'g24' });
  assert.equal(sdrNits.at(-1).label, '100 nits');
  // values strictly increase bottom-up
  for (const g of [hdr, sdrNits, pqCode && graticule('pq', 'code', { peakNits: 1000 })]) {
    for (let i = 1; i < g.length; i++) assert.ok(g[i].value > g[i - 1].value);
  }
  assert.equal(axisFor('hdr', 'nits'), 'pq');
  assert.equal(axisFor('sdr', 'nits'), 'sdr');
  assert.equal(axisFor('hdr', 'stops'), 'stops');
});

test('stats are reported in the selected unit', () => {
  const s = { peak: 0.9, floor: 0.1, mean: 0.5, meanLight: 0.25, peakStops: -1, floorStops: -8, rangeStops: 7 };
  assert.equal(formatStats(s, { format: 'hdr', unit: 'nits', peakNits: 1000 }).peak, '500 nits');
  assert.equal(formatStats(s, { format: 'hdr', unit: 'percent', peakNits: 1000 }).peak, '50%');
  assert.equal(formatStats(s, { format: 'sdr', unit: 'percent', peakNits: 100 }).peak, '90 IRE');
  assert.equal(formatStats(s, { format: 'sdr', unit: 'code', peakNits: 100 }).peak, '921');
  assert.equal(formatStats(s, { format: 'sdr', unit: 'nits', peakNits: 100 }).mean, '25 nits');
});

test('ADL is the mean light relative to peak, APL the mean signal', () => {
  const s = { peak: 0.9, floor: 0.1, mean: 0.5, meanLight: 0.25, peakStops: -1, floorStops: -8, rangeStops: 7 };
  const hdr = formatStats(s, { format: 'hdr', unit: 'nits', peakNits: 1000 });
  assert.equal(hdr.adl, '25% (250 nits)');
  assert.equal(hdr.apl, null);
  const sdr = formatStats(s, { format: 'sdr', unit: 'percent', peakNits: 100 });
  assert.equal(sdr.apl, '50 IRE');
  assert.equal(sdr.adl, '25% (25 nits)');
});

test('low-pass filter keeps flat areas and removes noise', async () => {
  const { lowPassRGBA, lowPassRadius } = await import('../js/waveform.js');
  const w = 64, h = 48;
  const d = new Uint8ClampedArray(w * h * 4);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 120 + Math.round((rnd() - 0.5) * 40); d[i + 3] = 255; }
  const sd = (a) => { let s = 0, s2 = 0, n = 0; for (let i = 0; i < a.length; i += 4) { s += a[i]; s2 += a[i] * a[i]; n++; } const m = s / n; return [m, Math.sqrt(s2 / n - m * m)]; };
  const [m0, s0] = sd(d);
  lowPassRGBA(d, w, h, 2);
  const [m1, s1] = sd(d);
  assert.ok(Math.abs(m1 - m0) < 1, 'mean preserved');
  assert.ok(s1 < s0 / 4, `noise ${s0.toFixed(1)} -> ${s1.toFixed(1)}`);
  assert.equal(lowPassRadius('off', 1280), 0);
  assert.ok(lowPassRadius('high', 1280) > lowPassRadius('low', 1280));
});
