/* =====================================================================
   VTC Web — interactive wind + current viewer for VSK5 maps.
   Mirrors the rendering and tide-blending math from VCT.ahk.

   Data layout (under ./VCT Grid/<Map>/):
     land.png                  — RGBA land overlay (transparent ocean)
     wind/<dir>.bin            — 512x512 grid of f32(mag), f32(dir_rad)
     tide/<state>.bin          — same layout for {low,flood,high,ebb}

   World ↔ grid mapping (matches VCT.ahk):
     gridSize = 512 (sqrt of nCells)
     Grid index 0   → world xmin (rendered RIGHT — axis is flipped)
     Grid index N-1 → world xmax (rendered LEFT)
     Same flip for Y.
   ===================================================================== */

'use strict';

// -------------------------------------------------------------------------
// Static data extracted from VCT.ahk
// -------------------------------------------------------------------------

const MAPS = {
    Auckland:     { xmin: 13092.70703125,  xmax: 38692.70703125,  ymin: 16931.962890625, ymax: 42531.9609375 },
    LaTrinite:    { xmin: 24143.94921875,  xmax: 49743.94921875,  ymin: 10349.9921875,   ymax: 35949.9921875 },
    Malmo:        { xmin: -12960.859375,   xmax: 18831.142578125, ymin: -19720.8046875,  ymax: 12071.197265625 },
    Marseille:    { xmin: -12960.859375,   xmax: 18831.142578125, ymin: -19720.8046875,  ymax: 12071.197265625 },
    Napoli:       { xmin: -10931.005859375,xmax: 29480.451171875, ymin: -18013.05859375, ymax: 22398.3984375 },
    PortoCervo:   { xmin: -4660.287109375, xmax: 8139.712890625,  ymin: -2548.501708984375, ymax: 10251.498046875 },
    QingDao:      { xmin: -12671.3447265625, xmax: 19120.65625,   ymin: -25569.685546875, ymax: 6222.31640625 },
    Rio:          { xmin: 187.0,           xmax: 25787.0,         ymin: -4228.0,         ymax: 21372.0 },
    SanFrancisco: { xmin: -6561.923828125, xmax: 19038.076171875, ymin: -10043.7939453125, ymax: 15556.20703125 },
    Sydney:       { xmin: -284.9677734375, xmax: 12515.0322265625,ymin: -2634.6220703125,ymax: 10165.3779296875 },
    Trapani:      { xmin: -12960.859375,   xmax: 18831.142578125, ymin: -19720.8046875,  ymax: 12071.197265625 },
    Valencia:     { xmin: -14245.8623046875, xmax: 6927.611328125,ymin: -15652.4326171875, ymax: 5521.041015625 },
    Vancouver:    { xmin: -19613.982421875,xmax: 19985.677734375, ymin: -17977.431640625,ymax: 21622.228515625 },
    Wight:        { xmin: 14868.04296875,  xmax: 40468.04296875,  ymin: 5142.380859375,  ymax: 30742.380859375 }
};

const LAND_MAPS = {
    Auckland:     { LeftX: 42761, RightX: 14389, TopZ: 45856, BottomZ: 14066 },
    LaTrinite:    { LeftX: 57380, RightX: 17780, TopZ: 42732, BottomZ: 837 },
    Malmo:        { LeftX: 11118, RightX: -12996, TopZ: 21807, BottomZ: -15180 },
    Marseille:    { LeftX: 19536, RightX: -21617, TopZ: 12924, BottomZ: -13233 },
    Napoli:       { LeftX: 27243, RightX: -42036, TopZ: 25763, BottomZ: -26233 },
    PortoCervo:   { LeftX: 10455, RightX: -4891, TopZ: 10387, BottomZ: -5400 },
    QingDao:      { LeftX: 40205, RightX: -37910, TopZ: 28002, BottomZ: -34281 },
    Rio:          { LeftX: 30889, RightX: -100, TopZ: 18343, BottomZ: 3079 },
    SanFrancisco: { LeftX: 13315, RightX: -24365, TopZ: 16702, BottomZ: -22816 },
    Sydney:       { LeftX: 21076, RightX: -6278, TopZ: 11787, BottomZ: -4604 },
    Trapani:      { LeftX: 20165, RightX: -14802, TopZ: 9332, BottomZ: -28953 },
    Valencia:     { LeftX: 33519, RightX: -14556, TopZ: 28325, BottomZ: -33065 },
    Vancouver:    { LeftX: 50525, RightX: -37541, TopZ: 41998, BottomZ: -31973 },
    Wight:        { LeftX: 49496, RightX: 6382, TopZ: 38669, BottomZ: 10107 }
};

const NO_TIDE_MAPS = new Set(['PortoCervo']);

// Tide-button "race start time" offsets (relative to high tide time).
// Ebb is 9h before, Low is 6h before, Flood is 3h before, High is same.
const TIDE_HOUR_OFFSETS = { ebb: -9, low: -6, flood: -3, high: 0 };

// Internal direction key → compass degrees (FROM direction).
const DIRECTION_DEG = {
    north: 0,        north_east: 45,  east: 90,        south_east: 135,
    south: 180,      south_west: 225, west: 270,       north_west: 315
};
// AHK FallbackWind table key → our internal key.
const _AHK_TO_DIR = {
    'North':'north','North East':'north_east','East':'east','South East':'south_east',
    'South':'south','South West':'south_west','West':'west','North West':'north_west'
};

// Fallback wind speeds (knots) for cells outside the grid. Per map, per
// Beaufort force, per direction.  Ported from FallbackWind in VCT.ahk.
// Maps not listed have no fallback (no arrows drawn outside their grid).
function _dirs(arr) {
    const o = {};
    const order = ['north','north_east','east','south_east','south','south_west','west','north_west'];
    order.forEach((k, i) => o[k] = arr[i]);
    return o;
}
const FALLBACK_WIND = {
    LaTrinite: {
        F3: _dirs([6.53, 6.53, 6.53, 7.19, 7.84, 7.19, 6.53, 6.53]),
        F4: _dirs([10.16,10.16,10.16,11.18,12.20,11.18,10.16,10.16]),
        F5: _dirs([14.16,14.16,14.16,15.57,16.99,15.57,14.16,14.16]),
        F6: _dirs([18.15,18.15,18.15,19.97,21.78,19.97,18.15,18.15]),
        F7: _dirs([22.51,22.51,22.51,24.76,27.01,24.76,22.51,22.51])
    },
    PortoCervo: { F3: 7.61, F4: 11.83, F5: 16.48, F6: 21.13, F7: 26.20 },
    Valencia: {
        F3: _dirs([0.97, 0.93, 0.90, 4.95, 9.00, 9.00, 9.00, 4.98]),
        F4: _dirs([1.51, 1.45, 1.40, 7.70,14.00,14.00,14.00, 7.75]),
        F5: _dirs([2.10, 2.02, 1.95,10.73,19.50,19.50,19.50,10.80]),
        F6: _dirs([2.69, 2.60, 2.50,13.75,25.00,25.00,25.00,13.84]),
        F7: _dirs([3.34, 3.22, 3.10,17.05,31.00,31.00,31.00,17.17])
    },
    Wight: {
        F3: _dirs([6.81, 6.18, 5.55, 7.27, 9.00, 9.00, 9.00, 7.90]),
        F4: _dirs([10.59, 9.61, 8.63,11.31,14.00,14.00,14.00,12.29]),
        F5: _dirs([14.75,13.38,12.02,15.76,19.50,19.50,19.50,17.12]),
        F6: _dirs([18.91,17.16,15.41,20.20,25.00,25.00,25.00,21.95]),
        F7: _dirs([23.45,21.28,19.11,25.05,31.00,31.00,31.00,27.22])
    }
};
// Default fallback wind speed (knots) by Beaufort force — used when the
// selected map isn't in the FALLBACK_WIND table.  Direction-uniform.
const DEFAULT_FORCE_SPEEDS = { F3: 9.0, F4: 14.0, F5: 19.5, F6: 25.0, F7: 31.0 };

// Lookup fallback wind for the (map, direction, force).  Used to paint
// arrows OUTSIDE the data grid so the wind layer extends infinitely.
// Returns { mag, dir, speedKn } or null (only if dir is unknown).
//   mag       — raw grid units so mag * windMultiplier(force) = knots
//   dir       — bin-radians convention (= -compass_radians_FROM)
//   speedKn   — knot value (post-multiplier)
function getFallbackWind(mapName, dirKey, force) {
    if (!dirKey) return null;
    const deg = DIRECTION_DEG[dirKey];
    if (deg == null) return null;
    const f = force || (state && state.windForce) || 'F5';
    let speedKn = null;

    const t = mapName ? FALLBACK_WIND[mapName] : null;
    if (t) {
        const tf = t[f];
        if (typeof tf === 'number')       speedKn = tf;
        else if (tf && tf[dirKey] != null) speedKn = tf[dirKey];
    }
    if (speedKn == null) speedKn = DEFAULT_FORCE_SPEEDS[f] || 19.5;

    return {
        mag:     speedKn / windMultiplier(f),
        dir:     -deg * Math.PI / 180,
        speedKn
    };
}

// -------------------------------------------------------------------------
// Bilinear sampling helpers (vector field interpolation)
// -------------------------------------------------------------------------

// Interpolate a vector field at fractional grid coords using the 4
// surrounding cell centres.  Vectors are interpolated in (u,v) space
// (correct for wind/current vector averaging), then converted back to
// (mag, dir).  Returns null if the sample falls outside the grid (caller
// can fall back to a default).
function bilinearSampleVector(grid, n, gxF, gyF) {
    if (!grid || gxF < 0 || gyF < 0 || gxF > n - 1 || gyF > n - 1) return null;
    let gx0 = Math.floor(gxF);
    let gy0 = Math.floor(gyF);
    if (gx0 >= n - 1) gx0 = n - 2;
    if (gy0 >= n - 1) gy0 = n - 2;
    const gx1 = gx0 + 1;
    const gy1 = gy0 + 1;
    const fx = gxF - gx0;
    const fy = gyF - gy0;

    const i00 = (gy0 * n + gx0) * 2;
    const i10 = (gy0 * n + gx1) * 2;
    const i01 = (gy1 * n + gx0) * 2;
    const i11 = (gy1 * n + gx1) * 2;

    const m00 = grid[i00], d00 = grid[i00 + 1];
    const m10 = grid[i10], d10 = grid[i10 + 1];
    const m01 = grid[i01], d01 = grid[i01 + 1];
    const m11 = grid[i11], d11 = grid[i11 + 1];

    // (mag, dir) → (u, v); bilerp u,v; convert back.
    const u00 = m00 * Math.cos(d00), v00 = m00 * Math.sin(d00);
    const u10 = m10 * Math.cos(d10), v10 = m10 * Math.sin(d10);
    const u01 = m01 * Math.cos(d01), v01 = m01 * Math.sin(d01);
    const u11 = m11 * Math.cos(d11), v11 = m11 * Math.sin(d11);

    const w00 = (1 - fx) * (1 - fy);
    const w10 =       fx * (1 - fy);
    const w01 = (1 - fx) *       fy;
    const w11 =       fx *       fy;

    const u = u00 * w00 + u10 * w10 + u01 * w01 + u11 * w11;
    const v = v00 * w00 + v10 * w10 + v01 * w01 + v11 * w11;
    return { mag: Math.sqrt(u * u + v * v), dir: Math.atan2(v, u) };
}

// Scalar bilinear (for magnitudes only, used by heatmap supersampling).
function bilinearMag(grid, n, gxF, gyF) {
    if (!grid) return 0;
    let gx0 = Math.max(0, Math.min(n - 2, Math.floor(gxF)));
    let gy0 = Math.max(0, Math.min(n - 2, Math.floor(gyF)));
    const gx1 = gx0 + 1, gy1 = gy0 + 1;
    const fx = Math.max(0, Math.min(1, gxF - gx0));
    const fy = Math.max(0, Math.min(1, gyF - gy0));
    const m00 = grid[(gy0 * n + gx0) * 2];
    const m10 = grid[(gy0 * n + gx1) * 2];
    const m01 = grid[(gy1 * n + gx0) * 2];
    const m11 = grid[(gy1 * n + gx1) * 2];
    return (1-fx)*(1-fy)*m00 + fx*(1-fy)*m10 + (1-fx)*fy*m01 + fx*fy*m11;
}

// Beaufort force → multiplier so that grid_mag * mult = knots.  The F5
// row is the baseline 19.5 used by VCT.ahk; other forces scale linearly
// to Beaufort midpoint speeds.
const WIND_FORCE_MULT = { F3: 9.0, F4: 14.0, F5: 19.5, F6: 25.0, F7: 31.0 };
function windMultiplier(force) {
    return WIND_FORCE_MULT[force || (state && state.windForce) || 'F5'] || 19.5;
}
const CURRENT_MULTIPLIER = 9.73;

// Tide blend curve (16-point piecewise LERP) from VCT.ahk.
// X = hours into the 12-h cycle from LOW slack. Phase 0 = LOW.
const TIDE_BLEND_CURVE = [
    [ 0.0, 0.000], [ 0.5, 0.500], [ 1.0, 0.666], [ 3.0, 1.000],
    [ 3.0, 0.000], [ 5.0, 0.333], [ 5.5, 0.500], [ 6.0, 1.000],
    [ 6.0, 0.000], [ 6.5, 0.500], [ 7.0, 0.666], [ 9.0, 1.000],
    [ 9.0, 0.000], [11.0, 0.333], [11.5, 0.500], [12.0, 1.000]
];
const TIDE_STATES_ORDER = ['low', 'flood', 'high', 'ebb'];

const ASSET_BASE = (() => {
    const params = new URLSearchParams(location.search);
    return params.get('base') || './VCT Grid';
})();

function joinUrl(...parts) {
    return parts.map((p, i) => {
        if (i === 0) {
            const m = p.match(/^(\.{1,2}\/)(.*)$/);
            if (m) return m[1] + m[2].split('/').map(encodeURIComponent).join('/');
        }
        return p.split('/').map(encodeURIComponent).join('/');
    }).join('/');
}

// -------------------------------------------------------------------------
// Color gradient stops (updated per latest spec)
// -------------------------------------------------------------------------

const WIND_STOPS = [
    { m: 0.000, r: 0,   g: 0,   b: 0   },  // black
    { m: 0.500, r: 0,   g: 0,   b: 255 },
    { m: 0.625, r: 0,   g: 255, b: 255 },
    { m: 0.750, r: 0,   g: 255, b: 0   },
    { m: 0.875, r: 255, g: 255, b: 0   },
    { m: 1.000, r: 255, g: 0,   b: 0   },
    { m: 1.250, r: 255, g: 0,   b: 255 }
];

const CURRENT_STOPS = [
    { m: 0.0, r: 0,   g: 0,   b: 0   },    // black
    { m: 0.1, r: 0,   g: 0,   b: 255 },
    { m: 0.5, r: 0,   g: 255, b: 255 },
    { m: 1.0, r: 0,   g: 255, b: 0   },
    { m: 1.5, r: 255, g: 255, b: 0   },
    { m: 2.0, r: 255, g: 0,   b: 0   },
    { m: 2.5, r: 255, g: 0,   b: 255 },
    { m: 3.0, r: 255, g: 255, b: 255 }
];

function lerpStopsRGB(stops, x) {
    if (x <= stops[0].m) return { r: stops[0].r, g: stops[0].g, b: stops[0].b };
    const last = stops[stops.length - 1];
    if (x >= last.m) return { r: last.r, g: last.g, b: last.b };
    for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i], b = stops[i + 1];
        if (x >= a.m && x <= b.m) {
            const f = (x - a.m) / (b.m - a.m);
            return {
                r: Math.round(a.r + f * (b.r - a.r)),
                g: Math.round(a.g + f * (b.g - a.g)),
                b: Math.round(a.b + f * (b.b - a.b))
            };
        }
    }
    return { r: last.r, g: last.g, b: last.b };
}
function rgbToStr(c) { return `rgb(${c.r},${c.g},${c.b})`; }
function getWindColor(ratio)    { return rgbToStr(lerpStopsRGB(WIND_STOPS, ratio)); }
function getCurrentColor(knots) { return rgbToStr(lerpStopsRGB(CURRENT_STOPS, knots)); }

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

const state = {
    map: null,
    wind: null,
    tideButton: null,
    showCurrent: false,

    // Defaults per latest spec.  All clock-like state is now in SECONDS
    // so the slider can scrub by seconds (HH:MM:SS-precise race timing).
    startSeconds:    12 * 3600,    // race start 12:00:00
    highTideSeconds: 18 * 3600,    // high tide  18:00:00
    sliderSeconds:   0,            // 0..43200 sec since race start (12 h max)
    prestartMinutes: 3,            // prestart countdown (subtracted from chrono)
    windForce:       'F5',         // Beaufort force for wind speed scaling

    // Single-level snapshot of (slider + start + showCurrent + tideButton)
    // captured just before a main tide button is pinned.  Restored when
    // the active tide button is clicked a second time, so the user lands
    // back on the intermediate state they were viewing (instead of "off").
    _tidePinSnapshot: null,

    landImages: {},
    windBins: {},
    tideBins: {},

    activeCurrentGrid: null,
    activeWindGrid: null,
    currentMaxMag: 0,
    windMaxMag: 0,
    gridSize: 512,

    // Heatmap cache (rebuilt when activeCurrentGrid changes).
    _heatmapCache: null,
};

// -------------------------------------------------------------------------
// Asset loading
// -------------------------------------------------------------------------

function landUrl(mapName)            { return joinUrl(ASSET_BASE, mapName, 'land.png'); }
function windBinUrl(mapName, dir)    { return joinUrl(ASSET_BASE, mapName, 'wind', dir + '.bin'); }
function tideBinUrl(mapName, state)  { return joinUrl(ASSET_BASE, mapName, 'tide', state + '.bin'); }

async function loadLandImage(mapName) {
    if (state.landImages[mapName]) return state.landImages[mapName];
    const url = landUrl(mapName);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => {
            state.landImages[mapName] = img;
            console.log('[VTC] land loaded:', url, img.naturalWidth + 'x' + img.naturalHeight);
            resolve(img);
        };
        img.onerror = () => reject(new Error('land.png failed: ' + url));
        img.src = url;
    });
}

async function loadBin(url, cacheKey, cache) {
    if (cache[cacheKey]) return cache[cacheKey];
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch ' + url + ' → HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const arr = new Float32Array(buf);
    cache[cacheKey] = arr;
    console.log('[VTC] bin loaded:', url, arr.length / 2 + ' cells');
    return arr;
}

async function loadWindBin(mapName, dir) {
    return loadBin(windBinUrl(mapName, dir), `${mapName}/${dir}`, state.windBins);
}
async function loadTideBin(mapName, t) {
    return loadBin(tideBinUrl(mapName, t), `${mapName}/${t}`, state.tideBins);
}

function maxMagOf(arr) {
    let max = 0;
    for (let i = 0; i < arr.length; i += 2) if (arr[i] > max) max = arr[i];
    return max;
}

let _statusTimer = null;
function showStatus(msg, isError) {
    const el = document.getElementById('status');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = msg;
    el.style.background = isError ? 'rgba(180,40,40,0.85)' : 'rgba(40,80,140,0.85)';
    el.style.display = 'block';
    clearTimeout(_statusTimer);
    _statusTimer = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

// -------------------------------------------------------------------------
// Tide phase + blending (port of VCT.ahk)
// -------------------------------------------------------------------------

function computeTidePhase(displayedMins, highTideMins) {
    const cycle = 720; // minutes
    // High tide = phase 0.5 (i.e. +6h after LOW slack), so subtract 6h to
    // convert "minutes after high tide" → "minutes after low slack".
    let elapsed = ((displayedMins - highTideMins + 360) % cycle + cycle) % cycle;
    return elapsed / cycle;
}

function getTideBlendStates(phase) {
    if (phase < 0) return { state1: 'low', state2: 'flood', w1: 1, w2: 0 };
    const hours = phase * 12;
    let q = Math.floor(hours / 3);
    if (q < 0) q = 0; else if (q > 3) q = 3;
    const pBase = q * 4;
    let w2 = 0, found = false;
    for (let i = 0; i < 3; i++) {
        const p1 = TIDE_BLEND_CURVE[pBase + i];
        const p2 = TIDE_BLEND_CURVE[pBase + i + 1];
        if (hours >= p1[0] && hours <= p2[0]) {
            const dx = p2[0] - p1[0];
            w2 = (dx <= 0) ? p1[1] : p1[1] + ((hours - p1[0]) / dx) * (p2[1] - p1[1]);
            found = true;
            break;
        }
    }
    if (!found) w2 = TIDE_BLEND_CURVE[pBase + 3][1];
    if (w2 < 0) w2 = 0; else if (w2 > 1) w2 = 1;
    return {
        state1: TIDE_STATES_ORDER[q],
        state2: TIDE_STATES_ORDER[(q + 1) % 4],
        w1: 1 - w2,
        w2: w2
    };
}

function blendGrids(a, b, wA, wB) {
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    if (a.length !== b.length) return a;
    const total = wA + wB;
    if (total <= 0) return null;
    wA /= total; wB /= total;
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 2) {
        const mA = a[i], dA = a[i + 1];
        const mB = b[i], dB = b[i + 1];
        const u = mA * Math.cos(dA) * wA + mB * Math.cos(dB) * wB;
        const v = mA * Math.sin(dA) * wA + mB * Math.sin(dB) * wB;
        out[i]     = Math.sqrt(u * u + v * v);
        out[i + 1] = Math.atan2(v, u);
    }
    return out;
}

// -------------------------------------------------------------------------
// View / camera transform
// -------------------------------------------------------------------------

const view = {
    canvasW: 0,
    canvasH: 0,
    ax: 0, bx: 0,   // fitted matrix:  fittedX = ax*wx + bx
    ay: 0, by: 0
};

// Additional pan/zoom layered on top of the fitted matrix.
const viewport = { scale: 1, panX: 0, panY: 0 };

function setCanvasSize() {
    const c = document.getElementById('map-canvas');
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    c.width  = Math.max(1, Math.round(cssW * dpr));
    c.height = Math.max(1, Math.round(cssH * dpr));
    view.canvasW = c.width;
    view.canvasH = c.height;
}

// Fit to the LAND bounding box, per latest spec. The grid (vector data)
// usually extends a bit beyond land; user can scroll/zoom to see it.
function fitView() {
    setCanvasSize();
    if (!state.map) return;
    const dpr = window.devicePixelRatio || 1;
    const lb = LAND_MAPS[state.map];

    const xmin = Math.min(lb.LeftX, lb.RightX);
    const xmax = Math.max(lb.LeftX, lb.RightX);
    const ymin = Math.min(lb.BottomZ, lb.TopZ);
    const ymax = Math.max(lb.BottomZ, lb.TopZ);

    const margin = 16 * dpr;
    const w = xmax - xmin;
    const h = ymax - ymin;
    const sx = (view.canvasW - 2 * margin) / w;
    const sy = (view.canvasH - 2 * margin) / h;
    const s  = Math.min(sx, sy);

    const drawW = w * s, drawH = h * s;
    const offX = (view.canvasW - drawW) / 2;
    const offY = (view.canvasH - drawH) / 2;

    // World X is flipped on canvas; same for Y.
    view.ax = -s;
    view.bx = offX + xmax * s;
    view.ay = -s;
    view.by = offY + ymax * s;

    // Reset user zoom/pan whenever we re-fit (e.g. on map change or resize).
    viewport.scale = 1;
    viewport.panX = 0;
    viewport.panY = 0;
}

function worldToScreen(wx, wy) {
    const fittedX = view.ax * wx + view.bx;
    const fittedY = view.ay * wy + view.by;
    const cx = view.canvasW / 2, cy = view.canvasH / 2;
    return {
        x: (fittedX - cx) * viewport.scale + cx + viewport.panX,
        y: (fittedY - cy) * viewport.scale + cy + viewport.panY
    };
}

function screenToWorld(sx, sy) {
    const cx = view.canvasW / 2, cy = view.canvasH / 2;
    const fittedX = (sx - viewport.panX - cx) / viewport.scale + cx;
    const fittedY = (sy - viewport.panY - cy) / viewport.scale + cy;
    return {
        x: (fittedX - view.bx) / view.ax,
        y: (fittedY - view.by) / view.ay
    };
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------

function render() {
    const c = document.getElementById('map-canvas');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!state.map) return;

    const showWind = state.wind && state.activeWindGrid && state.windMaxMag > 0;
    const showCurr = state.showCurrent && state.activeCurrentGrid && state.currentMaxMag > 0;
    const showBoth = showWind && showCurr;

    // 1. Heatmap of current — only when BOTH wind and current are selected.
    if (showBoth) {
        renderCurrentHeatmap(ctx, state.activeCurrentGrid, state.gridSize);
    }

    // 2. Vectors. When both layers visible, suppress current vectors and
    //    show only wind vectors on top of the heatmap (cleaner picture).
    if (showCurr && !showBoth) {
        drawArrows(ctx, state.activeCurrentGrid, state.currentMaxMag, 'current');
    }
    if (showWind) {
        drawArrows(ctx, state.activeWindGrid, state.windMaxMag, 'wind');
    }

    // 3. Land image — ON TOP of vectors per latest spec.
    const img = state.landImages[state.map];
    const lb  = LAND_MAPS[state.map];
    if (img && img.complete && img.naturalWidth > 0 && lb) {
        const tl = worldToScreen(lb.LeftX,  lb.TopZ);
        const br = worldToScreen(lb.RightX, lb.BottomZ);
        const x = Math.min(tl.x, br.x);
        const y = Math.min(tl.y, br.y);
        const w = Math.abs(br.x - tl.x);
        const h = Math.abs(br.y - tl.y);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x, y, w, h);
    }
}

function drawArrows(ctx, grid, maxMag, kind) {
    const n = state.gridSize;
    const dpr = window.devicePixelRatio || 1;
    const b = MAPS[state.map];

    const worldDx = (b.xmax - b.xmin) / (n - 1);
    const worldDy = (b.ymax - b.ymin) / (n - 1);

    // px-per-world-unit (with current zoom level).
    const s = Math.abs(view.ax) * viewport.scale;
    const cellPx = worldDx * s;
    let step = 1;
    while (cellPx * step < 20 * dpr) step *= 2;

    const arrowLenWorld = worldDx * step;
    ctx.lineWidth = 1.4 * dpr;
    ctx.lineCap = 'round';

    // For wind, extend iteration beyond the grid so that fallback wind
    // (uniform speed + the selected direction) fills the visible area
    // outside the data grid.  For current, stay within the grid.
    const fallback = (kind === 'wind') ? getFallbackWind(state.map, state.wind) : null;

    let gxMin = 0, gxMax = n - 1, gyMin = 0, gyMax = n - 1;
    if (fallback) {
        // Visible world bounds (axis-aligned, no rotation in this app).
        const c00 = screenToWorld(0, 0);
        const c11 = screenToWorld(view.canvasW, view.canvasH);
        const wxMin = Math.min(c00.x, c11.x), wxMax = Math.max(c00.x, c11.x);
        const wyMin = Math.min(c00.y, c11.y), wyMax = Math.max(c00.y, c11.y);
        gxMin = Math.floor((wxMin - b.xmin) / worldDx);
        gxMax = Math.ceil ((wxMax - b.xmin) / worldDx);
        gyMin = Math.floor((wyMin - b.ymin) / worldDy);
        gyMax = Math.ceil ((wyMax - b.ymin) / worldDy);
        // Snap to step grid so positions stay stable while panning.
        gxMin = Math.floor(gxMin / step) * step;
        gyMin = Math.floor(gyMin / step) * step;
    }

    for (let gy = gyMin; gy <= gyMax; gy += step) {
        for (let gx = gxMin; gx <= gxMax; gx += step) {
            let mag, dir;
            if (gx >= 0 && gx < n && gy >= 0 && gy < n) {
                const idx = (gy * n + gx) * 2;
                mag = grid[idx];
                dir = grid[idx + 1];
            } else if (fallback) {
                mag = fallback.mag;
                dir = fallback.dir;
            } else {
                continue;
            }
            if (mag === 0) continue;

            const wx = b.xmin + gx * worldDx;
            const wy = b.ymin + gy * worldDy;
            const p  = worldToScreen(wx, wy);

            if (p.x < -20 || p.x > view.canvasW + 20 ||
                p.y < -20 || p.y > view.canvasH + 20) continue;

            const color = (kind === 'wind')
                ? getWindColor(mag / maxMag)
                : getCurrentColor(mag * CURRENT_MULTIPLIER);
            ctx.strokeStyle = color;
            ctx.fillStyle   = color;

            const lenPx = (mag / maxMag) * arrowLenWorld * s;
            const angle = Math.PI / 2 - dir;
            const dx = Math.cos(angle), dy = Math.sin(angle);
            const halfX = (lenPx / 2) * dx;
            const halfY = (lenPx / 2) * dy;

            const sx0 = p.x - halfX, sy0 = p.y - halfY;
            const sx1 = p.x + halfX, sy1 = p.y + halfY;

            ctx.beginPath();
            ctx.moveTo(sx0, sy0);
            ctx.lineTo(sx1, sy1);

            const headLen = Math.min(8 * dpr, lenPx * 0.6);
            const sa = Math.atan2(sy1 - sy0, sx1 - sx0);
            const a1 = sa + Math.PI - Math.PI / 6;
            const a2 = sa + Math.PI + Math.PI / 6;
            ctx.moveTo(sx1, sy1);
            ctx.lineTo(sx1 + headLen * Math.cos(a1), sy1 + headLen * Math.sin(a1));
            ctx.moveTo(sx1, sy1);
            ctx.lineTo(sx1 + headLen * Math.cos(a2), sy1 + headLen * Math.sin(a2));
            ctx.stroke();
        }
    }
}

// Render the current grid as a semi-transparent heatmap.  Builds a 2x
// supersampled offscreen image where each pixel's magnitude is bilinear-
// interpolated from the 4 surrounding grid cells, then converted to its
// gradient colour.  This gives smooth transitions both inside cells and
// across colour-stop boundaries.  Cached and only rebuilt when the grid
// reference changes.
const HEATMAP_SUPER = 2;
function renderCurrentHeatmap(ctx, grid, n) {
    const b = MAPS[state.map];
    const W = n * HEATMAP_SUPER;

    let cache = state._heatmapCache;
    if (!cache || cache.size !== n) {
        const c = document.createElement('canvas');
        c.width = W; c.height = W;
        cache = { canvas: c, ctx: c.getContext('2d'), lastGrid: null, size: n, W };
        state._heatmapCache = cache;
    }
    if (cache.lastGrid !== grid) {
        const imgData = cache.ctx.createImageData(W, W);
        const data = imgData.data;
        // Pixel (px,py) center maps to grid coord:
        //   gxF = (W-1-px)/(W-1) * (n-1)     (X flipped for canvas)
        //   gyF = (W-1-py)/(W-1) * (n-1)     (Y flipped for canvas)
        const scale = (n - 1) / (W - 1);
        for (let py = 0; py < W; py++) {
            const gyF = (W - 1 - py) * scale;
            const gy0 = Math.max(0, Math.min(n - 2, Math.floor(gyF)));
            const fy = Math.max(0, Math.min(1, gyF - gy0));
            const gy1 = gy0 + 1;
            for (let px = 0; px < W; px++) {
                const gxF = (W - 1 - px) * scale;
                const gx0 = Math.max(0, Math.min(n - 2, Math.floor(gxF)));
                const fx = Math.max(0, Math.min(1, gxF - gx0));
                const gx1 = gx0 + 1;

                const m00 = grid[(gy0 * n + gx0) * 2];
                const m10 = grid[(gy0 * n + gx1) * 2];
                const m01 = grid[(gy1 * n + gx0) * 2];
                const m11 = grid[(gy1 * n + gx1) * 2];

                const mag = (1-fx)*(1-fy)*m00 + fx*(1-fy)*m10
                          + (1-fx)*    fy *m01 + fx*    fy *m11;
                const col = lerpStopsRGB(CURRENT_STOPS, mag * CURRENT_MULTIPLIER);
                const pi = (py * W + px) * 4;
                data[pi]     = col.r;
                data[pi + 1] = col.g;
                data[pi + 2] = col.b;
                data[pi + 3] = 128;   // 50 % alpha
            }
        }
        cache.ctx.putImageData(imgData, 0, 0);
        cache.lastGrid = grid;
    }

    const tl = worldToScreen(b.xmax, b.ymax);
    const br = worldToScreen(b.xmin, b.ymin);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cache.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

// -------------------------------------------------------------------------
// Selection / data refresh
// -------------------------------------------------------------------------

async function selectMap(mapName) {
    state.map = mapName;
    state.activeWindGrid = null;
    state.activeCurrentGrid = null;
    state._heatmapCache = null;   // gridSize may change

    document.querySelectorAll('.map-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.map === mapName);
    });
    document.getElementById('empty-msg').style.display = 'none';
    document.getElementById('hud').style.display = 'block';
    document.getElementById('slider-wrap').style.display = 'flex';

    const noTide = NO_TIDE_MAPS.has(mapName);
    document.querySelectorAll('.tide-btn').forEach(b => {
        b.classList.toggle('disabled', noTide);
        b.disabled = noTide;
    });
    if (noTide) {
        state.showCurrent = false;
        state.tideButton = null;
        document.querySelectorAll('.tide-btn').forEach(b => b.classList.remove('active'));
    }

    try {
        await loadLandImage(mapName);
    } catch (e) {
        console.warn(e);
        showStatus('Land image failed: ' + e.message, true);
    }

    fitView();
    await refreshActiveLayers();
    updateHud();
    render();
}

async function refreshActiveLayers() {
    if (state.wind && state.map) {
        try {
            const g = await loadWindBin(state.map, state.wind);
            state.activeWindGrid = g;
            state.windMaxMag = maxMagOf(g);
            state.gridSize = Math.round(Math.sqrt(g.length / 2));
        } catch (e) {
            console.warn(e);
            showStatus('Wind grid failed: ' + e.message, true);
            state.activeWindGrid = null;
            state.windMaxMag = 0;
        }
    } else {
        state.activeWindGrid = null;
        state.windMaxMag = 0;
    }

    if (state.showCurrent && state.map && !NO_TIDE_MAPS.has(state.map)) {
        try {
            const grid = await computeCurrentGrid();
            const prev = state.activeCurrentGrid;
            state.activeCurrentGrid = grid;
            state.currentMaxMag = grid ? maxMagOf(grid) : 0;
            if (grid) state.gridSize = Math.round(Math.sqrt(grid.length / 2));
            if (prev !== grid && state._heatmapCache) state._heatmapCache.lastGrid = null;
        } catch (e) {
            console.warn(e);
            showStatus('Current grid failed: ' + e.message, true);
            state.activeCurrentGrid = null;
            state.currentMaxMag = 0;
        }
    } else {
        state.activeCurrentGrid = null;
        state.currentMaxMag = 0;
    }
}

async function computeCurrentGrid() {
    if (!state.map) return null;

    const b = getTideBlendStates(phaseNow());

    if (b.w2 < 1e-4) return await loadTideBin(state.map, b.state1);
    if (b.w1 < 1e-4) return await loadTideBin(state.map, b.state2);

    const [a, c] = await Promise.all([
        loadTideBin(state.map, b.state1),
        loadTideBin(state.map, b.state2)
    ]);
    return blendGrids(a, c, b.w1, b.w2);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function humanizeDir(d) {
    return {
        north: 'N', north_east: 'NE', east: 'E', south_east: 'SE',
        south: 'S', south_west: 'SW', west: 'W', north_west: 'NW'
    }[d] || d;
}

// Format a seconds-of-day value as "HH:MM:SS".
function secsToHHMMSS(s) {
    s = Math.round(s);
    s = ((s % 86400) + 86400) % 86400;
    return String(Math.floor(s / 3600)).padStart(2, '0') + ':' +
           String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' +
           String(s % 60).padStart(2, '0');
}

// Flexible time parser. Accepts:
//   "9"        →  09:00:00
//   "12"       →  12:00:00
//   "123"      →  12:03:00      (XYZ → XY:0Z:00)
//   "1234"     →  12:34:00
//   "12345"    →  12:34:05      (XYZWV → XY:ZW:0V)
//   "123456"   →  12:34:56
//   "3:4:2"    →  03:04:02
//   "1:23"     →  01:23:00
//   "12:34:56" →  12:34:56
// Returns total seconds (0..86399), or null if unparseable.
function parseFlexibleTime(str) {
    if (str == null) return null;
    str = String(str).trim();
    if (!str) return null;

    let h = 0, m = 0, s = 0;
    if (str.includes(':')) {
        const parts = str.split(':');
        if (parts.length < 1 || parts.length > 3) return null;
        h = parts[0] ? parseInt(parts[0], 10) : 0;
        m = (parts.length >= 2 && parts[1]) ? parseInt(parts[1], 10) : 0;
        s = (parts.length >= 3 && parts[2]) ? parseInt(parts[2], 10) : 0;
        if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
    } else {
        const d = str.replace(/[^0-9]/g, '');
        if (!d.length || d.length > 6) return null;
        switch (d.length) {
            case 1: h = parseInt(d, 10); break;
            case 2: h = parseInt(d, 10); break;
            case 3: h = parseInt(d.slice(0, 2), 10); m = parseInt(d.slice(2), 10); break;
            case 4: h = parseInt(d.slice(0, 2), 10); m = parseInt(d.slice(2), 10); break;
            case 5: h = parseInt(d.slice(0, 2), 10);
                    m = parseInt(d.slice(2, 4), 10);
                    s = parseInt(d.slice(4), 10); break;
            case 6: h = parseInt(d.slice(0, 2), 10);
                    m = parseInt(d.slice(2, 4), 10);
                    s = parseInt(d.slice(4), 10); break;
        }
    }
    if (h > 23) h = 23;
    if (m > 59) m = 59;
    if (s > 59) s = 59;
    if (h < 0 || m < 0 || s < 0) return null;
    return h * 3600 + m * 60 + s;
}

// Apply a tide-button offset to the High tide time and wrap the result
// into the [07:00, 19:00] band by adding 12h if it lands at night.
function applyTideOffset(highTideSecs, offsetHours) {
    let ns = highTideSecs + offsetHours * 3600;
    ns = ((ns % 86400) + 86400) % 86400;
    if (ns < 7 * 3600 || ns > 19 * 3600) {
        ns = ((ns + 12 * 3600) % 86400 + 86400) % 86400;
    }
    return ns;
}

// Convenience accessors derived from state.
function dayTimeSeconds() {
    return state.startSeconds + state.sliderSeconds;
}
function phaseNow() {
    // Convert seconds → fractional minutes for the phase math.
    return computeTidePhase(dayTimeSeconds() / 60, state.highTideSeconds / 60);
}

function tideLabel() {
    if (!state.showCurrent) return 'off';
    const b = getTideBlendStates(phaseNow());
    if (b.w2 < 0.05) return cap(b.state1);
    if (b.w1 < 0.05) return cap(b.state2);
    return `${cap(b.state1)} → ${cap(b.state2)} (${Math.round(b.w2 * 100)}%)`;
}

// Format signed seconds as ±H:MM:SS  ("+0:03:00", "-0:00:03").
function fmtSignedTime(s) {
    const sign = s < 0 ? '-' : '+';
    const a = Math.abs(Math.round(s));
    return sign + Math.floor(a / 3600) + ':'
                + String(Math.floor((a % 3600) / 60)).padStart(2, '0') + ':'
                + String(a % 60).padStart(2, '0');
}

function updateHud() {
    // Race time = sliderSeconds - prestartMinutes * 60.  Negative during
    // the prestart countdown, zero at race start, positive afterwards.
    const raceSec = state.sliderSeconds - state.prestartMinutes * 60;
    document.getElementById('hud-chrono').textContent = fmtSignedTime(raceSec);
    document.getElementById('vert-slider-readout').textContent = fmtSignedTime(raceSec);

    // Day time: full HH:MM:SS clock for race start + slider, modulo 24h.
    document.getElementById('hud-time').textContent = secsToHHMMSS(dayTimeSeconds());

    updateBlendButton();
    updateLegend();
}

// -------------------------------------------------------------------------
// Dynamic "blend" button — shown in the Current column when the current
// layer is on but no fixed tide button is pinned (user is scrubbing time).
// Its label matches the HUD blend description, e.g. "Flood → High (9%)".
// Clicking it toggles current off.
// -------------------------------------------------------------------------

let _blendBtn = null;
function ensureBlendButton() {
    if (_blendBtn) return _blendBtn;
    _blendBtn = document.createElement('button');
    _blendBtn.id = 'blend-btn';
    _blendBtn.className = 'btn tide-btn blend-btn';
    _blendBtn.style.display = 'none';
    _blendBtn.addEventListener('click', async () => {
        // Toggle the current layer on/off.  Always unpin any fixed tide.
        state.showCurrent = !state.showCurrent;
        state.tideButton = null;
        document.querySelectorAll('.tide-btn').forEach(b => b.classList.remove('active'));
        await refreshActiveLayers();
        updateHud();
        render();
    });
    return _blendBtn;
}

const ABBR = { ebb: 'Ebb', low: 'Low', flood: 'Flood', high: 'High' };

function updateBlendButton() {
    const btn = ensureBlendButton();
    const col = document.getElementById('current-col');

    // Always-visible when phase is non-pure and the map has tide data —
    // even if the current layer itself is off. Clicking turns it on.
    const noMap = !state.map || NO_TIDE_MAPS.has(state.map);
    if (noMap || state.tideButton) { btn.style.display = 'none'; return; }

    const bs = getTideBlendStates(phaseNow());
    if (bs.w1 < 0.05 || bs.w2 < 0.05) { btn.style.display = 'none'; return; }

    const pct = Math.round(bs.w2 * 100);
    // 4-line label: stateA / ↓ / stateB / percent.
    btn.innerHTML =
        `<span class="blend-line">${ABBR[bs.state1]}</span>` +
        `<span class="blend-line blend-arrow">↓</span>` +
        `<span class="blend-line">${ABBR[bs.state2]}</span>` +
        `<span class="blend-line">${pct}%</span>`;
    btn.classList.toggle('active', state.showCurrent);
    btn.style.display = '';

    // Insert at the correct column position based on cycle direction:
    //   low → flood  : between Low and Flood
    //   flood → high : between Flood and High
    //   high → ebb   : after High (cycle wraps out of column)
    //   ebb → low    : between Ebb and Low
    const ref = {
        'low|flood':  col.querySelector('[data-tide="flood"]'),
        'flood|high': col.querySelector('[data-tide="high"]'),
        'high|ebb':   null,   // append at end
        'ebb|low':    col.querySelector('[data-tide="low"]')
    }[bs.state1 + '|' + bs.state2];

    if (ref) {
        if (btn.nextSibling !== ref) col.insertBefore(btn, ref);
    } else {
        if (col.lastChild !== btn) col.appendChild(btn);
    }
}

// -------------------------------------------------------------------------
// UI wiring — buttons
// -------------------------------------------------------------------------

document.querySelectorAll('.map-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (state.map === btn.dataset.map) return;
        selectMap(btn.dataset.map);
    });
});

document.querySelectorAll('.wind-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (!state.map) return;
        const dir = btn.dataset.wind;
        state.wind = (state.wind === dir) ? null : dir;
        document.querySelectorAll('.wind-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.wind === state.wind);
        });
        await refreshActiveLayers();
        updateHud();
        render();
    });
});

// True toggle: 1st click pins + sets race start; same-button click again
// turns current off.  Clicking a different tide button switches.
document.querySelectorAll('.tide-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (!state.map || NO_TIDE_MAPS.has(state.map)) return;
        const t = btn.dataset.tide;

        if (state.tideButton === t) {
            // Second click on the active tide button:  restore the state
            // captured at pin time (so the user lands back on the
            // intermediate blend they were viewing).  If no snapshot
            // exists (we pinned from "off") just turn current off.
            const snap = state._tidePinSnapshot;
            if (snap) {
                state.tideButton    = snap.tideButton;
                state.showCurrent   = snap.showCurrent;
                state.startSeconds  = snap.startSeconds;
                state.sliderSeconds = snap.sliderSeconds;
                document.getElementById('start-time').value  = secsToHHMMSS(snap.startSeconds);
                document.getElementById('vert-slider').value = snap.sliderSeconds;
                state._tidePinSnapshot = null;
            } else {
                state.tideButton = null;
                state.showCurrent = false;
            }
        } else {
            // Pinning a (new) tide button.  Capture the prior state so a
            // second click on this button can restore it.
            state._tidePinSnapshot = {
                tideButton:    state.tideButton,
                showCurrent:   state.showCurrent,
                startSeconds:  state.startSeconds,
                sliderSeconds: state.sliderSeconds
            };
            state.tideButton = t;
            state.showCurrent = true;
            // Move race start so the displayed (slider = 0) moment IS this
            // tide.  Offsets in hours: Ebb=-9, Low=-6, Flood=-3, High=0.
            // If the result lands outside 07:00–19:00 we add 12 h.
            const ns = applyTideOffset(state.highTideSeconds, TIDE_HOUR_OFFSETS[t]);
            state.startSeconds = ns;
            document.getElementById('start-time').value = secsToHHMMSS(ns);
            state.sliderSeconds = 0;
            document.getElementById('vert-slider').value = 0;
        }

        document.querySelectorAll('.tide-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tide === state.tideButton);
        });
        await refreshActiveLayers();
        updateHud();
        render();
    });
});

// -------------------------------------------------------------------------
// UI wiring — time inputs
// -------------------------------------------------------------------------

// Flexible HH:MM:SS time input.  We don't auto-insert colons during
// typing — the parser handles "1234" and "12:30" equally well, so the
// user types freely and we normalise on commit (Enter / blur / change).
function attachTimeInput(id, applyFn) {
    const el = document.getElementById(id);
    const commit = async () => {
        const secs = parseFlexibleTime(el.value);
        if (secs == null) {
            showStatus('Time must be HH:MM:SS (24-hour). Single numbers OK too.', true);
            return;
        }
        el.value = secsToHHMMSS(secs);
        applyFn(secs);
        await refreshActiveLayers();
        updateHud();
        render();
    };
    el.addEventListener('change', commit);
    el.addEventListener('blur', () => {
        const secs = parseFlexibleTime(el.value);
        if (secs != null) el.value = secsToHHMMSS(secs);
    });
}
attachTimeInput('start-time', s => { state.startSeconds = s; });
attachTimeInput('high-tide-time', s => {
    state.highTideSeconds = s;
    // If a tide button is pinned, re-anchor race start to follow it.
    if (state.tideButton) {
        const ns = applyTideOffset(s, TIDE_HOUR_OFFSETS[state.tideButton]);
        state.startSeconds = ns;
        document.getElementById('start-time').value = secsToHHMMSS(ns);
        state.sliderSeconds = 0;
        document.getElementById('vert-slider').value = 0;
    }
});

// Wind strength (F3..F7) radio buttons.
document.querySelectorAll('.windforce-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        state.windForce = btn.dataset.force;
        document.querySelectorAll('.windforce-btn').forEach(b => {
            b.classList.toggle('active', b === btn);
        });
        // Force change affects tooltip knots and fallback magnitude.
        updateHud();
        render();
    });
});

// Prestart-time radio buttons (0, 1, 3, 5, 8 minutes).
document.querySelectorAll('.prestart-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const mins = parseInt(btn.dataset.pre, 10) || 0;
        state.prestartMinutes = mins;
        document.querySelectorAll('.prestart-btn').forEach(b => {
            b.classList.toggle('active', b === btn);
        });
        updateHud();
    });
});

// ±5 min / Reset step buttons advance the slider value.  Using the slider
// implicitly "unpins" the tide button (the displayed state may diverge
// from a pure-state moment).
function unpinTide() {
    if (state.tideButton) {
        state.tideButton = null;
        document.querySelectorAll('.tide-btn').forEach(b => b.classList.remove('active'));
    }
}
// Internal step is in SECONDS. The "5 min" buttons add/subtract 300.
const SLIDER_MAX_SEC = 43200;  // 12 h — will drop to 3600 (1 h) after a
                                // course is imported in a future change.
function stepSlider(deltaSec) {
    let v = state.sliderSeconds + deltaSec;
    if (v < 0) v = 0;
    if (v > SLIDER_MAX_SEC) v = SLIDER_MAX_SEC;
    state.sliderSeconds = v;
    document.getElementById('vert-slider').value = v;
    unpinTide();
    refreshActiveLayers().then(() => { updateHud(); render(); });
}
document.getElementById('step-minus').addEventListener('click', () => stepSlider(-300));
document.getElementById('step-plus').addEventListener('click',  () => stepSlider(+300));
document.getElementById('step-reset').addEventListener('click', () => {
    state.sliderSeconds = 0;
    document.getElementById('vert-slider').value = 0;
    unpinTide();
    refreshActiveLayers().then(() => { updateHud(); render(); });
});

// Vertical slider — value is in SECONDS (0..43200). rAF-throttled so
// scrubbing 43k positions doesn't spawn 43k blend rebuilds.
const slider = document.getElementById('vert-slider');
let sliderRafPending = false;
slider.addEventListener('input', () => {
    state.sliderSeconds = parseInt(slider.value, 10) || 0;
    unpinTide();
    if (sliderRafPending) return;
    sliderRafPending = true;
    requestAnimationFrame(async () => {
        sliderRafPending = false;
        await refreshActiveLayers();
        updateHud();
        render();
    });
});

// -------------------------------------------------------------------------
// Pan / zoom — mouse, wheel, touch (Pointer Events API)
// -------------------------------------------------------------------------

const canvasEl = document.getElementById('map-canvas');
const pointers = new Map();         // pointerId -> {x, y} in CSS px
let dragInfo = null;                 // { pid, sx, sy, panX, panY }
let pinchInfo = null;                // { dist, midX, midY }

function pointerPosCss(e)  { return { x: e.clientX, y: e.clientY }; }
function cssToCanvas(p) {
    const rect = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: (p.x - rect.left) * dpr, y: (p.y - rect.top) * dpr };
}

canvasEl.addEventListener('pointerdown', e => {
    if (!state.map) return;
    canvasEl.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pointerPosCss(e));

    if (pointers.size === 1) {
        dragInfo = {
            pid: e.pointerId,
            sx: e.clientX, sy: e.clientY,
            panX: viewport.panX, panY: viewport.panY
        };
        canvasEl.classList.add('dragging');
        hideTooltip();
    } else if (pointers.size === 2) {
        dragInfo = null;   // cancel pan, switch to pinch
        const pts = [...pointers.values()];
        pinchInfo = {
            dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
            midX: (pts[0].x + pts[1].x) / 2,
            midY: (pts[0].y + pts[1].y) / 2
        };
    }
});

canvasEl.addEventListener('pointermove', e => {
    if (!state.map) return;

    if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, pointerPosCss(e));
    }

    if (pointers.size === 1 && dragInfo && dragInfo.pid === e.pointerId) {
        const dpr = window.devicePixelRatio || 1;
        viewport.panX = dragInfo.panX + (e.clientX - dragInfo.sx) * dpr;
        viewport.panY = dragInfo.panY + (e.clientY - dragInfo.sy) * dpr;
        render();
    } else if (pointers.size === 2 && pinchInfo) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        // Translate by midpoint delta.
        const dpr = window.devicePixelRatio || 1;
        viewport.panX += (midX - pinchInfo.midX) * dpr;
        viewport.panY += (midY - pinchInfo.midY) * dpr;

        // Zoom centered on midpoint.
        const cv = cssToCanvas({ x: midX, y: midY });
        const before = screenToWorld(cv.x, cv.y);
        const factor = dist / pinchInfo.dist;
        viewport.scale = Math.max(0.05, Math.min(80, viewport.scale * factor));
        const after = worldToScreen(before.x, before.y);
        viewport.panX += cv.x - after.x;
        viewport.panY += cv.y - after.y;

        pinchInfo.dist = dist;
        pinchInfo.midX = midX;
        pinchInfo.midY = midY;
        render();
    } else {
        // Hover only — tooltip.
        updateTooltip(e);
    }
});

function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchInfo = null;
    if (pointers.size === 0) {
        dragInfo = null;
        canvasEl.classList.remove('dragging');
    }
}
canvasEl.addEventListener('pointerup',     endPointer);
canvasEl.addEventListener('pointercancel', endPointer);
canvasEl.addEventListener('pointerleave',  e => {
    if (!pointers.has(e.pointerId)) hideTooltip();
});

canvasEl.addEventListener('wheel', e => {
    if (!state.map) return;
    e.preventDefault();
    const cv = cssToCanvas({ x: e.clientX, y: e.clientY });
    const before = screenToWorld(cv.x, cv.y);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    viewport.scale = Math.max(0.05, Math.min(80, viewport.scale * factor));
    const after = worldToScreen(before.x, before.y);
    viewport.panX += cv.x - after.x;
    viewport.panY += cv.y - after.y;
    render();
}, { passive: false });

canvasEl.addEventListener('dblclick', () => {
    // Quick "reset view" — refit and re-render.
    if (!state.map) return;
    fitView();
    render();
});

// -------------------------------------------------------------------------
// Tooltip
// -------------------------------------------------------------------------

const tooltipEl = document.getElementById('tooltip');

function hideTooltip() {
    tooltipEl.style.display = 'none';
}

// -------------------------------------------------------------------------
// Color-scale legend overlay (top-right of canvas)
// -------------------------------------------------------------------------

const legendEl = document.getElementById('legend');

function updateLegend() {
    if (!legendEl) return;
    const showWind    = state.wind && state.activeWindGrid && state.windMaxMag > 0;
    const showCurrent = state.showCurrent && state.activeCurrentGrid;
    if (!showWind && !showCurrent) {
        legendEl.style.display = 'none';
        return;
    }

    let html = '';

    if (showWind) {
        // Wind ratios → actual knots at the SELECTED force.
        const maxKn = state.windMaxMag * windMultiplier(state.windForce);
        html += `<div class="group"><h4>WIND (${state.windForce})</h4>`;
        // Skip black; show the 6 colored stops.
        for (let i = 1; i < WIND_STOPS.length; i++) {
            const s  = WIND_STOPS[i];
            const kn = s.m * maxKn;
            html += `<div class="row">`
                  + `<span class="swatch" style="background:rgb(${s.r},${s.g},${s.b})"></span>`
                  + `<span class="val">${kn.toFixed(1)} kn</span></div>`;
        }
        html += `</div>`;
    }

    if (showCurrent) {
        html += `<div class="group"><h4>CURRENT</h4>`;
        for (let i = 1; i < CURRENT_STOPS.length; i++) {
            const s = CURRENT_STOPS[i];
            html += `<div class="row">`
                  + `<span class="swatch" style="background:rgb(${s.r},${s.g},${s.b})"></span>`
                  + `<span class="val">${s.m.toFixed(1)} kn</span></div>`;
        }
        html += `</div>`;
    }

    legendEl.innerHTML = html;
    legendEl.style.display = 'block';
}

function updateTooltip(e) {
    if (!state.map) { hideTooltip(); return; }
    const hasWind = !!state.activeWindGrid;
    const hasCurr = !!state.activeCurrentGrid;
    if (!hasWind && !hasCurr) { hideTooltip(); return; }

    const cv = cssToCanvas({ x: e.clientX, y: e.clientY });
    const w  = screenToWorld(cv.x, cv.y);
    const b  = MAPS[state.map];
    const n  = state.gridSize;

    // Fractional grid coords (matching the cell-to-world mapping in
    // drawArrows: gx = (worldX - xmin) / worldDx).
    const gxF = (w.x - b.xmin) / (b.xmax - b.xmin) * (n - 1);
    const gyF = (w.y - b.ymin) / (b.ymax - b.ymin) * (n - 1);
    const insideGrid = gxF >= 0 && gxF <= n - 1 && gyF >= 0 && gyF <= n - 1;

    // Compass-FROM angle. Matches VCT.ahk: wDeg = -dir * 180/PI normalized.
    const compassFrom = d => ((-d * 180 / Math.PI) % 360 + 360) % 360;

    const parts = [];
    if (hasWind) {
        let mag, dir;
        if (insideGrid) {
            const s = bilinearSampleVector(state.activeWindGrid, n, gxF, gyF);
            if (s) { mag = s.mag; dir = s.dir; }
        } else {
            // Outside grid — fall back to the uniform fallback wind.
            const fb = getFallbackWind(state.map, state.wind);
            if (fb) { mag = fb.mag; dir = fb.dir; }
        }
        if (mag !== undefined) {
            const kn = mag * windMultiplier(state.windForce);
            parts.push(`<div><span class="lbl">Wind</span>${kn.toFixed(1)} kn @ ${compassFrom(dir).toFixed(0)}°</div>`);
        }
    }
    if (hasCurr && insideGrid) {
        const s = bilinearSampleVector(state.activeCurrentGrid, n, gxF, gyF);
        if (s) {
            const kn = s.mag * CURRENT_MULTIPLIER;
            parts.push(`<div><span class="lbl">Current</span>${kn.toFixed(2)} kn @ ${compassFrom(s.dir).toFixed(0)}°</div>`);
        }
    }
    if (!parts.length) { hideTooltip(); return; }

    tooltipEl.innerHTML = parts.join('');
    tooltipEl.style.display = 'block';
    const ttW = tooltipEl.offsetWidth, ttH = tooltipEl.offsetHeight;
    let left = e.clientX + 14;
    let top  = e.clientY + 14;
    if (left + ttW > window.innerWidth)  left = e.clientX - 14 - ttW;
    if (top  + ttH > window.innerHeight) top  = e.clientY - 14 - ttH;
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top  = top + 'px';
}

// -------------------------------------------------------------------------
// Resize
// -------------------------------------------------------------------------

window.addEventListener('resize', () => {
    fitView();
    render();
});

// -------------------------------------------------------------------------
// URL parameters (for future AHK launch).
// -------------------------------------------------------------------------

(async function init() {
    const params = new URLSearchParams(location.search);

    let codeData = null;
    const codeStr = params.get('code');
    if (codeStr) {
        try {
            const json = atob(codeStr.replace(/-/g, '+').replace(/_/g, '/'));
            codeData = JSON.parse(json);
        } catch (e) {
            console.warn('Bad ?code= payload:', e);
        }
    }
    const p = key => (codeData && codeData[key] != null)
        ? codeData[key] : params.get(key);

    if (p('start')) {
        const s = parseFlexibleTime(p('start'));
        if (s != null) {
            state.startSeconds = s;
            document.getElementById('start-time').value = secsToHHMMSS(s);
        }
    }
    if (p('high')) {
        const s = parseFlexibleTime(p('high'));
        if (s != null) {
            state.highTideSeconds = s;
            document.getElementById('high-tide-time').value = secsToHHMMSS(s);
        }
    }
    if (p('force') && WIND_FORCE_MULT[p('force')]) {
        state.windForce = p('force');
        document.querySelectorAll('.windforce-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.force === state.windForce);
        });
    }
    if (p('prestart') != null) {
        const pm = parseInt(p('prestart'), 10);
        if (!isNaN(pm) && pm >= 0) {
            state.prestartMinutes = pm;
            document.querySelectorAll('.prestart-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.pre, 10) === pm);
            });
        }
    }
    if (p('t') != null) {
        const t = parseInt(p('t'), 10) || 0;
        // URL param now interpreted as seconds (matches the slider).
        state.sliderSeconds = Math.max(0, Math.min(SLIDER_MAX_SEC, t));
        document.getElementById('vert-slider').value = state.sliderSeconds;
    }

    setCanvasSize();

    if (p('map') && MAPS[p('map')]) {
        if (p('wind')) state.wind = p('wind');
        if (p('tide')) {
            state.tideButton = p('tide');
            state.showCurrent = true;
        }
        await selectMap(p('map'));
        document.querySelectorAll('.wind-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.wind === state.wind);
        });
        document.querySelectorAll('.tide-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tide === state.tideButton);
        });
    }

    updateHud();
})();
