#!/usr/bin/env python3
"""Generate the sample photos used by the app's "Try the samples" button.

Renders two pieces of content (a sunset landscape and a test chart), then
simulates photographing them on a projector screen with a phone:

  * projector: gamma 2.4, ~2000:1 native contrast, hotspot fall-off, soft edge
  * room: keystoned screen that does not fill the frame, velvet border,
    wall/floor/speakers lit by spill light from the screen
  * camera: locked exposure, lens veiling glare, vignetting, noise, sRGB, JPEG

Everything is procedural, so the samples are free of any third-party rights.
Usage: python3 generate.py [out_dir] [--content photo.jpg ...]
  --content projects your own photo(s) (letter/pillar-boxed into the 16:9 raster)
  and writes <name>_on_screen.jpg next to the standard samples.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

RNG = np.random.default_rng(7)
CW, CH = 1920, 1080          # content (projector raster)
PW, PH = 2016, 1512          # photo (4:3 phone sensor)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def box_blur(img, r):
    """Fast separable box blur on an (H, W[, C]) float array."""
    if r < 1:
        return img
    out = img
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(out, pad, mode='edge'), axis=axis, dtype=np.float64)
        n = out.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        out = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return out


def blur(img, r):
    """Approximate Gaussian: three box blurs."""
    r = max(1, int(round(r / 1.7)))
    for _ in range(3):
        img = box_blur(img, r)
    return img


def fbm(w, h, base=4, octaves=6, gain=0.5, seed=0, aspect=1.0):
    """Fractal value noise in [0, 1] using bicubic upsampling of random grids."""
    rng = np.random.default_rng(seed)
    total = np.zeros((h, w), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        gw = max(2, int(base * 2 ** o))
        gh = max(2, int(base * 2 ** o / aspect))
        grid = rng.random((gh, gw)).astype(np.float32)
        up = np.asarray(Image.fromarray(grid, 'F').resize((w, h), Image.BICUBIC))
        total += amp * up
        norm += amp
        amp *= gain
    return np.clip(total / norm, 0, 1)


def ridge(w, seed, base, octaves, amp):
    rng = np.random.default_rng(seed)
    x = np.zeros(w, np.float32)
    a = 1.0
    for o in range(octaves):
        n = int(base * 2 ** o) + 2
        pts = rng.random(n).astype(np.float32) * 2 - 1
        x += a * np.interp(np.linspace(0, n - 1, w), np.arange(n), pts)
        a *= 0.5
    return x * amp


def homography(src, dst):
    """3x3 H mapping src points -> dst points (4 pairs)."""
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    _, _, vt = np.linalg.svd(np.array(A, np.float64))
    H = vt[-1].reshape(3, 3)
    return H / H[2, 2]


def sample_bilinear(img, x, y):
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    a = img[y0, x0]; b = img[y0, x0 + 1]; c = img[y0 + 1, x0]; d = img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def srgb_encode(l):
    l = np.clip(l, 0, 1)
    return np.where(l <= 0.0031308, l * 12.92, 1.055 * np.power(l, 1 / 2.4) - 0.055)


# ---------------------------------------------------------------------------
# content
# ---------------------------------------------------------------------------

def sunset():
    """Sunset over a lake. Rendered scene-linear, tone-mapped to a 2.4 gamma signal."""
    w, h = CW, CH
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = xx / w, yy / h
    horizon = 0.56
    sun = np.array([0.66, 0.47])

    # Sky: deep blue overhead to warm near the horizon.
    t = np.clip(v / horizon, 0, 1)[..., None]
    top = np.array([0.035, 0.07, 0.20])
    mid = np.array([0.32, 0.30, 0.42])
    low = np.array([1.35, 0.62, 0.22])
    sky = np.where(t < 0.55, top + (mid - top) * (t / 0.55), mid + (low - mid) * ((t - 0.55) / 0.45))
    d = np.sqrt(((u - sun[0]) * w / h) ** 2 + (v - sun[1]) ** 2)
    glow = 2.2 * np.exp(-d / 0.05) + 0.9 * np.exp(-d / 0.16) + 0.25 * np.exp(-d / 0.45)
    sky = sky + glow[..., None] * np.array([1.0, 0.62, 0.30])
    disk = np.clip((0.028 - d) / 0.003, 0, 1)
    sky = sky * (1 - disk[..., None]) + disk[..., None] * np.array([40.0, 30.0, 18.0])

    # Clouds: stretched fbm, lit warm underneath near the sun, dark grey away from it.
    n = fbm(w, h, base=3, octaves=6, seed=3, aspect=0.25)
    band = np.exp(-((v - 0.25) / 0.12) ** 2) + 0.7 * np.exp(-((v - 0.42) / 0.05) ** 2)
    cover = np.clip((n - 0.52) * 4.0, 0, 1) * band
    lit = 0.12 + 1.6 * np.exp(-d / 0.22)
    cloud = lit[..., None] * np.array([1.0, 0.55, 0.35]) + 0.03
    sky = sky * (1 - cover[..., None] * 0.85) + cloud * cover[..., None] * 0.85

    img = sky.copy()

    # Mountains: far (hazy) and near (dark) ridges.
    far = horizon - 0.07 + ridge(w, 11, 3, 7, 0.045)[None, :] * np.ones((h, 1))
    near = horizon - 0.02 + ridge(w, 12, 2, 7, 0.06)[None, :] * np.ones((h, 1))
    far_col = np.array([0.20, 0.14, 0.17]) + 0.25 * np.exp(-np.abs(u - sun[0]) / 0.2)[..., None] * np.array([0.5, 0.3, 0.2])
    near_col = np.array([0.025, 0.022, 0.03])
    img = np.where((v > far)[..., None], far_col, img)
    img = np.where((v > near)[..., None], near_col * (0.6 + 0.8 * fbm(w, h, 8, 4, seed=5)[..., None]), img)

    # Lake: reflection of the sky with ripples and a glittering sun path.
    lake = v > horizon
    ripple = (fbm(w, h, base=40, octaves=3, seed=9, aspect=0.08) - 0.5) * 0.03
    ry = np.clip(2 * horizon - v + ripple * (v - horizon) * 6, 0, horizon - 0.001)
    rx = u
    refl = sample_bilinear(sky.astype(np.float32), rx * (w - 1), ry * (h - 1)) * 0.55
    glitter_n = fbm(w, h, base=60, octaves=2, seed=10, aspect=0.1)
    path = np.exp(-((u - sun[0]) / (0.015 + 0.25 * (v - horizon))) ** 2)
    glitter = np.clip((glitter_n - 0.6) * 6, 0, 1) * path * 12
    water = refl + glitter[..., None] * np.array([1.0, 0.75, 0.45])
    water *= np.clip(1.25 - (v - horizon) * 1.6, 0.25, 1)[..., None]
    img = np.where(lake[..., None], water, img)

    # Foreground shore and pines in silhouette, with a hint of rim light.
    shore = 0.86 + ridge(w, 21, 2, 6, 0.03)[None, :] * np.ones((h, 1))
    fg = v > shore
    pil = Image.new('L', (w, h), 0)
    dr = ImageDraw.Draw(pil)
    for i in range(16):
        x = RNG.uniform(0.0, 0.35) * w if i < 10 else RNG.uniform(0.82, 1.0) * w
        base = (0.86 + RNG.uniform(0.0, 0.06)) * h
        tall = RNG.uniform(0.22, 0.48) * h
        width = tall * RNG.uniform(0.18, 0.26)
        for k in range(7):
            f = k / 7
            y0 = base - tall * (0.15 + f * 0.85)
            half = width * (1 - f) * 0.55 + 3
            dr.polygon([(x - half, y0 + tall * 0.18), (x + half, y0 + tall * 0.18), (x, y0 - tall * 0.05)], fill=255)
        dr.rectangle([x - 4, base - tall * 0.2, x + 4, base], fill=255)
    trees = np.asarray(pil, np.float32) / 255
    fg = np.maximum(fg.astype(np.float32), trees)
    detail = 0.004 + 0.012 * fbm(w, h, 20, 4, seed=22)
    fg_col = detail[..., None] * np.array([1.0, 0.9, 0.7])
    img = img * (1 - fg[..., None]) + fg_col * fg[..., None]

    # Camera-like tone mapping of the scene: exposure, filmic shoulder, 2.4 gamma encode.
    x = img * 1.35
    mapped = x * (1 + x / 30.0) / (1 + x)
    return np.clip(mapped, 0, 1) ** (1 / 2.4)


def chart():
    """Grey steps, ramp, 75% bars and a ColorChecker-style patch grid, as a 2.4 signal."""
    w, h = CW, CH
    img = Image.new('RGB', (w, h), (20, 20, 20))
    dr = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 26)
    except OSError:
        font = ImageFont.load_default()
    # 11-step grey scale (0..100 IRE)
    sw = w / 11
    for i in range(11):
        val = round(i / 10 * 255)
        dr.rectangle([i * sw, 0, (i + 1) * sw, h * 0.30], fill=(val, val, val))
        dr.text((i * sw + sw / 2, h * 0.30 - 34), f'{i * 10}', fill=(128, 128, 128) if 3 < i < 8 else ((200, 200, 200) if i <= 3 else (60, 60, 60)), font=font, anchor='mm')
    # Ramp
    ramp = np.linspace(0, 255, w).astype(np.uint8)
    rampimg = Image.fromarray(np.repeat(np.repeat(ramp[None, :, None], 3, axis=2), int(h * 0.12), axis=0), 'RGB')
    img.paste(rampimg, (0, int(h * 0.32)))
    # 75% colour bars
    bars = [(191, 191, 191), (191, 191, 0), (0, 191, 191), (0, 191, 0), (191, 0, 191), (191, 0, 0), (0, 0, 191)]
    bw = w / 7
    for i, c in enumerate(bars):
        dr.rectangle([i * bw, h * 0.46, (i + 1) * bw, h * 0.62], fill=c)
    # ColorChecker-style patches (sRGB approximations)
    cc = [(115, 82, 68), (194, 150, 130), (98, 122, 157), (87, 108, 67), (133, 128, 177), (103, 189, 170),
          (214, 126, 44), (80, 91, 166), (193, 90, 99), (94, 60, 108), (157, 188, 64), (224, 163, 46),
          (56, 61, 150), (70, 148, 73), (175, 54, 60), (231, 199, 31), (187, 86, 149), (8, 133, 161),
          (243, 243, 242), (200, 200, 200), (160, 160, 160), (122, 122, 121), (85, 85, 85), (52, 52, 52)]
    pw, ph = w / 6, h * 0.36 / 4
    for i, c in enumerate(cc):
        x, y = (i % 6) * pw, h * 0.64 + (i // 6) * ph
        dr.rectangle([x + 6, y + 6, x + pw - 6, y + ph - 6], fill=c)
    a = np.asarray(img, np.float32) / 255
    return a  # already a display signal


# ---------------------------------------------------------------------------
# photograph simulation
# ---------------------------------------------------------------------------

def photograph(signal, exposure=0.70, seed=1):
    """Simulate a phone photo of `signal` (CHxCWx3, 0..1) projected in a room.
    Returns an 8-bit sRGB uint8 array (PH, PW, 3)."""
    rng = np.random.default_rng(seed)
    # Picture corners in the photo: mild keystone + roll; does not fill the frame.
    pic = np.array([[268, 262], [1770, 236], [1786, 1092], [252, 1106]], np.float64)
    # Screen surface is a little larger than the projected raster; velvet border around that.
    c = pic.mean(axis=0)
    screen = c + (pic - c) * np.array([1.035, 1.05])
    border = c + (pic - c) * np.array([1.075, 1.11])

    yy, xx = np.mgrid[0:PH, 0:PW].astype(np.float64)
    pts = np.stack([xx.ravel(), yy.ravel(), np.ones(xx.size)])

    def inside(quad):
        Hq = homography(quad, [[0, 0], [1, 0], [1, 1], [0, 1]])
        q = Hq @ pts
        uu, vv = (q[0] / q[2]).reshape(PH, PW), (q[1] / q[2]).reshape(PH, PW)
        return uu, vv, (uu >= 0) & (uu <= 1) & (vv >= 0) & (vv <= 1)

    u, v, in_pic = inside(pic)
    _, _, in_screen = inside(screen)
    _, _, in_border = inside(border)

    # Projector light (relative units, 1.0 = peak white at centre).
    black = 1 / 2000
    proj = black + (1 - black) * np.power(np.clip(signal, 0, 1), 2.4)
    proj = proj.astype(np.float32)
    lp = sample_bilinear(proj, u * (CW - 1), v * (CH - 1))
    r2 = ((u - 0.5) ** 2 + (v - 0.5) ** 2)[..., None] / 0.5
    hotspot = 1 - 0.12 * r2
    light = np.where(in_pic[..., None], lp * hotspot, 0).astype(np.float32)
    light = blur(light, 1.6)  # projector focus / screen gain softness

    # Room: spill light from the screen, falling off with distance.
    mean_screen = float(proj.mean())
    dx, dy = (xx - c[0]) / PW, (yy - c[1]) / PH
    fall = 1 / (1 + 6 * (dx ** 2 + dy ** 2))
    spill = (0.0015 + 0.05 * mean_screen * fall)[..., None].astype(np.float32)
    refl = np.full((PH, PW), 0.35, np.float32)                  # wall
    refl[yy > 1300 + 0.04 * (xx - PW / 2)] = 0.18               # floor
    refl[in_border] = 0.02                                       # velvet border
    refl[in_screen] = 0.85                                       # unlit screen surface
    for x0 in (60, PW - 300):                                    # speakers
        sel = (xx > x0) & (xx < x0 + 240) & (yy > 1150) & (yy < 1512)
        refl[sel] = 0.05
        cone = ((xx - (x0 + 120)) ** 2 + (yy - 1300) ** 2) < 70 ** 2
        refl[cone] = 0.025
    wall_tint = np.array([1.0, 0.95, 0.88], np.float32)
    refl[in_pic] = 0.85                                          # spill also lands on the picture
    room = spill * refl[..., None] * wall_tint
    scene = light + room

    # Camera: lens veiling glare, vignetting, exposure, noise, sRGB, JPEG.
    glare = blur(scene, 90) * 0.004 + blur(scene, 12) * 0.003
    scene = scene + glare
    vr = ((xx - PW / 2) ** 2 + (yy - PH / 2) ** 2) / ((PW / 2) ** 2 + (PH / 2) ** 2)
    scene = scene * (1 - 0.18 * vr)[..., None]
    sensor = scene * exposure
    noise = rng.normal(0, 1, sensor.shape).astype(np.float32) * np.sqrt(0.00025 * sensor + 2e-6)
    sensor = np.clip(sensor + noise, 0, 1)
    return (srgb_encode(sensor) * 255 + 0.5).astype(np.uint8)


def fit_raster(path):
    """Load a photo as a display signal, fitted (boxed) into the 16:9 projector raster."""
    im = Image.open(path).convert('RGB')
    s = min(CW / im.width, CH / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    canvas = Image.new('RGB', (CW, CH), (0, 0, 0))
    canvas.paste(im, ((CW - im.width) // 2, (CH - im.height) // 2))
    return np.asarray(canvas, np.float32) / 255


def main():
    args = sys.argv[1:]
    contents = []
    while '--content' in args:
        i = args.index('--content')
        contents.append(args[i + 1])
        del args[i:i + 2]
    out = args[0] if args else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(out, exist_ok=True)
    jobs = {
        'white.jpg': np.ones((CH, CW, 3), np.float32),
        'black.jpg': np.zeros((CH, CW, 3), np.float32),
        'sunset.jpg': sunset().astype(np.float32),
        'chart.jpg': chart(),
    }
    for path in contents:
        jobs[os.path.splitext(os.path.basename(path))[0] + '_on_screen.jpg'] = fit_raster(path)
    for i, (name, sig) in enumerate(jobs.items()):
        photo = photograph(sig, seed=i + 1)
        Image.fromarray(photo).save(os.path.join(out, name), quality=90)
        if name == 'sunset.jpg':
            Image.fromarray((np.clip(sig, 0, 1) * 255 + 0.5).astype(np.uint8)).save(
                os.path.join(out, 'sunset_source.jpg'), quality=92)
        print('wrote', name)


if __name__ == '__main__':
    main()
