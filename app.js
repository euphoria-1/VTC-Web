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

// Maps where the tide data is unreliable (or absent on disk).  Tide
// buttons + heatmap are disabled for these.
const NO_TIDE_MAPS = new Set(['PortoCervo', 'Valencia', 'Trapani']);

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

    // Slider/start position from the last "intermediate" view (current
    // visible at a non-pure-tide phase).  Captured when transitioning
    // FROM intermediate to a pinned main tide.  Used to:
    //   - keep the intermediate button visible after toggling a main
    //     tide off (so the user can click it to come back)
    //   - restore the intermediate state when the intermediate button
    //     is clicked while a main tide is pinned
    _intermediateSnapshot: null,

    // Locked mode: true when the page was opened with a course payload
    // — sidebar hidden, only the slider and the two lock toggles
    // (Wind / Current) are interactive.
    locked: false,
    _lockedWind: null,           // wind direction baked in by the URL

    // Course (start line, finish line, legs with marks/gates/arcs) —
    // decoded from the ?code= URL parameter sent by the AHK app.
    //   course.SL    { leftX, leftY, rightX, rightY }
    //   course.FL    { leftX, leftY, rightX, rightY }
    //   course.Legs  [{ startX?, startY?, endX, endY,
    //                   isGate, gate?: { leftX, leftY, rightX, rightY },
    //                   arc?:   { centerX, centerY, radius,
    //                              entryX, entryY, exitX, exitY } }, ...]
    // Game coords are in metres, same convention as MAPS[mapName].
    course: null,

    // Optional course-meta fields piggy-backed on the ?code= payload.
    courseName: '',          // e.g. "Up-Down 1.0 nm"
    shiftMode:  '',          // 'None' | 'Stable' | 'Osci' | 'Shifty' | 'Wild'

    // User-placed dots (right-click). Each: { x, y } in game metres.
    // Multiple allowed; right-clicking near an existing dot removes it.
    userDots: [],

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
    ay: 0, by: 0,
    rotation: 0     // radians; positive rotates the rendered map clockwise
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

// Fit to the COURSE if one is loaded (so the race area dominates the
// view), else to the LAND bounding box.  The grid usually extends a bit
// beyond land; the user can scroll/zoom to see further.
function fitView() {
    setCanvasSize();
    if (!state.map) return;
    const dpr = window.devicePixelRatio || 1;

    // Compute the course-up rotation FIRST, so the bbox can be rotated
    // into screen space before we choose a scale.  Otherwise a course
    // rotated by 90° squeezes into the wrong axis and ends up too big.
    let rotation = 0;
    if (state.course && state.course.Legs && state.course.Legs.length > 0) {
        const c0 = state.course;
        const leg0 = c0.Legs[0];
        const slMidX = (c0.SL.leftX + c0.SL.rightX) / 2;
        const slMidY = (c0.SL.leftY + c0.SL.rightY) / 2;
        const startX = (typeof leg0.startX === 'number') ? leg0.startX : slMidX;
        const startY = (typeof leg0.startY === 'number') ? leg0.startY : slMidY;
        const dx = leg0.endX - startX;
        const dy = leg0.endY - startY;
        if (dx !== 0 || dy !== 0) rotation = Math.atan2(dx, dy);
    }
    view.rotation = rotation;

    let xmin, xmax, ymin, ymax;
    const cb = courseBounds();
    if (cb) {
        // Pad the course bbox by ~20 % so marks aren't right on the
        // edge. Slightly more breathing room than the AHK preview.
        const padX = (cb.xmax - cb.xmin) * 0.20;
        const padY = (cb.ymax - cb.ymin) * 0.20;
        xmin = cb.xmin - padX; xmax = cb.xmax + padX;
        ymin = cb.ymin - padY; ymax = cb.ymax + padY;
    } else {
        const lb = LAND_MAPS[state.map];
        xmin = Math.min(lb.LeftX, lb.RightX);
        xmax = Math.max(lb.LeftX, lb.RightX);
        ymin = Math.min(lb.BottomZ, lb.TopZ);
        ymax = Math.max(lb.BottomZ, lb.TopZ);
    }

    // Untransformed extents (used for ax/bx/ay/by below). The fit
    // scale, however, must be computed from the rotation-aware extents
    // because render() rotates the canvas around its centre.
    let fitW = xmax - xmin;
    let fitH = ymax - ymin;
    if (cb && rotation !== 0) {
        // Rotate the bbox corners around its centre by `rotation` and
        // recompute extents.  The world-X axis is flipped on canvas, so
        // the visual rotation seen on screen is the same `rotation`
        // value applied to canvas coords — that's what we sized for.
        const ax = Math.abs(Math.cos(rotation));
        const ay = Math.abs(Math.sin(rotation));
        fitW = (xmax - xmin) * ax + (ymax - ymin) * ay;
        fitH = (xmax - xmin) * ay + (ymax - ymin) * ax;
    }

    const margin = 16 * dpr;
    const sx = (view.canvasW - 2 * margin) / fitW;
    const sy = (view.canvasH - 2 * margin) / fitH;
    const s  = Math.min(sx, sy);

    const w = xmax - xmin, h = ymax - ymin;
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

// Compute the axis-aligned bounding box covering every mark of the
// course, or null if no course is loaded.  Game-meter coords.
function courseBounds() {
    const c = state.course;
    if (!c || !c.SL) return null;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    const add = (x, y) => {
        if (typeof x !== 'number' || typeof y !== 'number') return;
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
    };
    add(c.SL.leftX, c.SL.leftY); add(c.SL.rightX, c.SL.rightY);
    if (c.FL) { add(c.FL.leftX, c.FL.leftY); add(c.FL.rightX, c.FL.rightY); }
    if (c.Legs) for (const l of c.Legs) {
        add(l.endX, l.endY);
        if (l.gate) { add(l.gate.leftX, l.gate.leftY); add(l.gate.rightX, l.gate.rightY); }
        if (l.arc)  { add(l.arc.centerX, l.arc.centerY); }
    }
    if (!isFinite(xmin)) return null;
    return { xmin, xmax, ymin, ymax };
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

// Undo only the canvas-level rotation (not pan/zoom).  Returns the
// "pre-rotation" screen position — what worldToScreen would produce
// for the same point.  Used by zoom/pinch handlers to keep the cursor
// anchored over a world point while scale changes.
function unrotateScreen(sx, sy) {
    if (view.rotation === 0) return { x: sx, y: sy };
    const cx = view.canvasW / 2, cy = view.canvasH / 2;
    const dx = sx - cx, dy = sy - cy;
    const cosR = Math.cos(-view.rotation);
    const sinR = Math.sin(-view.rotation);
    return {
        x: dx * cosR - dy * sinR + cx,
        y: dx * sinR + dy * cosR + cy
    };
}

function screenToWorld(sx, sy) {
    // Undo the canvas-level rotation applied in render() so the inverse
    // mapping lines up with worldToScreen (which returns pre-rotation
    // coords).  No-op when view.rotation === 0.
    const cx = view.canvasW / 2, cy = view.canvasH / 2;
    let lx = sx, ly = sy;
    if (view.rotation !== 0) {
        const dx = sx - cx, dy = sy - cy;
        const cosR = Math.cos(-view.rotation);
        const sinR = Math.sin(-view.rotation);
        lx = dx * cosR - dy * sinR + cx;
        ly = dx * sinR + dy * cosR + cy;
    }
    const fittedX = (lx - viewport.panX - cx) / viewport.scale + cx;
    const fittedY = (ly - viewport.panY - cy) / viewport.scale + cy;
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!state.map) return;

    // Apply the chart "course-up" rotation (no-op unless a course was
    // loaded).  All worldToScreen results remain in pre-rotation coords
    // and the canvas transform handles the final visual rotation.
    if (view.rotation !== 0) {
        const cx = view.canvasW / 2, cy = view.canvasH / 2;
        ctx.translate(cx, cy);
        ctx.rotate(view.rotation);
        ctx.translate(-cx, -cy);
    }

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

    // 4. Course (start line, legs, gates, arcs, finish line, mark circles)
    if (state.course && state.course.SL) {
        drawCourse(ctx);
    }

    // 5. User-placed dots (right-click). Drawn on canvas so they
    //    follow rotation/zoom; the value boxes are HTML siblings.
    drawUserDots(ctx);

    // Mark tips (per-mark wind/current readouts) — must run AFTER all
    // canvas transforms are settled so screen positions are accurate.
    updateMarkTips();
    updateUserTips();
    resolveTipOverlaps();   // mobile: stop boxes from stacking on each other
    updateInfoBar();
    updateCompass();

    // Reposition the "show sidebar" button (when collapsed) so it sits
    // just below the top-overlay row, under whichever block is leftmost.
    positionExpandButton();
}

// -------------------------------------------------------------------------
// Course rendering — port of the equivalent logic in VCT.ahk so the
// startline / legs / gates / arcs / finish line / mark circles look the
// same on both sides.
// -------------------------------------------------------------------------
function drawCourse(ctx) {
    const c   = state.course;
    const dpr = window.devicePixelRatio || 1;

    // Helper: world (game meters) → screen pixels.
    const g2s = (x, y) => worldToScreen(x, y);

    // Pixels-per-game-metre at the current zoom.
    const mPerPx = Math.abs(view.ax) * viewport.scale;

    // 1) Start line — bright green.
    const sl1 = g2s(c.SL.leftX,  c.SL.leftY);
    const sl2 = g2s(c.SL.rightX, c.SL.rightY);
    ctx.lineWidth   = 3 * dpr;
    ctx.lineCap     = 'round';
    ctx.strokeStyle = '#00FF00';
    ctx.beginPath();
    ctx.moveTo(sl1.x, sl1.y);
    ctx.lineTo(sl2.x, sl2.y);
    ctx.stroke();
    const slMid = { x: (sl1.x + sl2.x) / 2, y: (sl1.y + sl2.y) / 2 };

    // 2) Legs (white straight + arrowhead + optional arc + optional gate).
    if (c.Legs && c.Legs.length) {
        let overrideStartPt = null;
        for (let i = 0; i < c.Legs.length; i++) {
            const leg = c.Legs[i];
            const sPt = overrideStartPt ? overrideStartPt : ((typeof leg.startX === 'number')
                ? g2s(leg.startX, leg.startY) : slMid);
            overrideStartPt = null;
            const ePt = g2s(leg.endX, leg.endY);

            // Straight segment.
            ctx.lineWidth   = 2 * dpr;
            ctx.strokeStyle = '#FFFFFF';
            ctx.fillStyle   = '#FFFFFF';
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(sPt.x, sPt.y);
            ctx.lineTo(ePt.x, ePt.y);
            ctx.stroke();

            // Arrowhead at the leg endpoint.
            const legAng = Math.atan2(ePt.y - sPt.y, ePt.x - sPt.x);
            const headL  = 10 * dpr;
            const a1 = legAng + Math.PI - Math.PI / 6;
            const a2 = legAng + Math.PI + Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(ePt.x, ePt.y);
            ctx.lineTo(ePt.x + headL * Math.cos(a1), ePt.y + headL * Math.sin(a1));
            ctx.lineTo(ePt.x + headL * Math.cos(a2), ePt.y + headL * Math.sin(a2));
            ctx.closePath();
            ctx.fill();

            // Optional rounding arc around a mark.
            if (leg.arc) {
                const ac     = g2s(leg.arc.centerX, leg.arc.centerY);
                const aEntry = g2s(leg.arc.entryX,  leg.arc.entryY);
                const aExit  = g2s(leg.arc.exitX,   leg.arc.exitY);
                const canvasR = Math.hypot(aEntry.x - ac.x, aEntry.y - ac.y);

                const inA = Math.atan2(aEntry.y - sPt.y, aEntry.x - sPt.x);
                let nextPt;
                if (i + 1 < c.Legs.length) {
                    nextPt = g2s(c.Legs[i + 1].endX, c.Legs[i + 1].endY);
                } else if (c.FL && c.FL.leftX !== undefined) {
                    const fl1 = g2s(c.FL.leftX,  c.FL.leftY);
                    const fl2 = g2s(c.FL.rightX, c.FL.rightY);
                    nextPt = { x: (fl1.x + fl2.x) / 2, y: (fl1.y + fl2.y) / 2 };
                } else {
                    nextPt = {
                        x: aExit.x + (aEntry.x - sPt.x),
                        y: aExit.y + (aEntry.y - sPt.y)
                    };
                }
                const outA = Math.atan2(nextPt.y - aExit.y, nextPt.x - aExit.x);

                const inDx     = aEntry.x - sPt.x;
                const inDy     = aEntry.y - sPt.y;
                const centerDx = ac.x - aEntry.x;
                const centerDy = ac.y - aEntry.y;
                const cross    = inDx * centerDy - inDy * centerDx;
                let ccw;
                if (Math.abs(cross) > 1e-4) {
                    ccw = cross < 0;
                } else {
                    let turnA = outA - inA;
                    while (turnA >  Math.PI) turnA -= 2 * Math.PI;
                    while (turnA < -Math.PI) turnA += 2 * Math.PI;
                    ccw = turnA < 0;
                }

                // Use the TRUE buoy center to guarantee the arc stays anchored to the mark
                const startA = Math.atan2(aEntry.y - ac.y, aEntry.x - ac.x);
                const endA   = Math.atan2(aExit.y - ac.y, aExit.x - ac.x);

                // Draw the true curve and capture the exact mathematical endpoint
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth   = 2 * dpr;
                ctx.lineCap     = 'round';
                ctx.beginPath();
                ctx.arc(ac.x, ac.y, canvasR, startA, endA, ccw);
                ctx.stroke();
                
                overrideStartPt = { 
                    x: ac.x + canvasR * Math.cos(endA), 
                    y: ac.y + canvasR * Math.sin(endA) 
                };
            }

            // Gate line (cyan) — drawn between the two gate marks.
            if (leg.isGate && leg.gate) {
                const g1 = g2s(leg.gate.leftX,  leg.gate.leftY);
                const g2_ = g2s(leg.gate.rightX, leg.gate.rightY);
                ctx.strokeStyle = '#00FFFF';
                ctx.lineWidth   = 2 * dpr;
                ctx.beginPath();
                ctx.moveTo(g1.x, g1.y);
                ctx.lineTo(g2_.x, g2_.y);
                ctx.stroke();
            }
        }
    }

    // 3) Finish line — red.
    if (c.FL && c.FL.leftX !== undefined) {
        const fl1 = g2s(c.FL.leftX,  c.FL.leftY);
        const fl2 = g2s(c.FL.rightX, c.FL.rightY);
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth   = 3 * dpr;
        ctx.beginPath();
        ctx.moveTo(fl1.x, fl1.y);
        ctx.lineTo(fl2.x, fl2.y);
        ctx.stroke();
    }

    // 4) Mark circles (4 m physical radius — same as VCT.ahk).
    const marks = [];
    if (c.SL) marks.push([c.SL.leftX, c.SL.leftY], [c.SL.rightX, c.SL.rightY]);
    if (c.FL && c.FL.leftX !== undefined)
        marks.push([c.FL.leftX, c.FL.leftY], [c.FL.rightX, c.FL.rightY]);
    if (c.Legs) {
        for (const l of c.Legs) {
            if (l.isGate && l.gate)
                marks.push([l.gate.leftX,  l.gate.leftY],
                           [l.gate.rightX, l.gate.rightY]);
            else if (l.arc && l.arc.centerX !== undefined)
                marks.push([l.arc.centerX, l.arc.centerY]);
        }
    }
    const markRadiusPx = 4 * mPerPx;   // 4 m in screen pixels
    if (markRadiusPx >= 1) {
        ctx.strokeStyle = '#FFA500';
        ctx.lineWidth   = 2 * dpr;
        for (const [mx, my] of marks) {
            const p = g2s(mx, my);
            ctx.beginPath();
            ctx.arc(p.x, p.y, markRadiusPx, 0, 2 * Math.PI);
            ctx.stroke();
        }
    }
}

// Stub — the expand-sidebar button is now CSS-positioned at a fixed
// top-left location.  Kept so callers don't break.
function positionExpandButton() {}

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
        // Visible world bounds.  With course-up rotation the canvas's
        // two diagonal corners can collapse to a near-straight line in
        // world coords, so we MUST sample all four canvas corners and
        // take the bbox of their world positions.
        const corners = [
            screenToWorld(0,               0),
            screenToWorld(view.canvasW,    0),
            screenToWorld(0,               view.canvasH),
            screenToWorld(view.canvasW,    view.canvasH)
        ];
        let wxMin =  Infinity, wxMax = -Infinity;
        let wyMin =  Infinity, wyMax = -Infinity;
        for (const c of corners) {
            if (c.x < wxMin) wxMin = c.x;
            if (c.x > wxMax) wxMax = c.x;
            if (c.y < wyMin) wyMin = c.y;
            if (c.y > wyMax) wyMax = c.y;
        }
        gxMin = Math.floor((wxMin - b.xmin) / worldDx);
        gxMax = Math.ceil ((wxMax - b.xmin) / worldDx);
        gyMin = Math.floor((wyMin - b.ymin) / worldDy);
        gyMax = Math.ceil ((wyMax - b.ymin) / worldDy);
        // Snap to step grid so positions stay stable while panning.
        gxMin = Math.floor(gxMin / step) * step;
        gyMin = Math.floor(gyMin / step) * step;
    }

    // Hoist the rotation transform out of the per-cell loop.  We do the
    // visibility cull against POST-rotation screen coords; worldToScreen
    // returns pre-rotation coords (the canvas transform applies the
    // rotation visually at drawImage time).
    const isRot = view.rotation !== 0;
    const rotCx = view.canvasW / 2, rotCy = view.canvasH / 2;
    const cosR = isRot ? Math.cos(view.rotation) : 1;
    const sinR = isRot ? Math.sin(view.rotation) : 0;

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

            // Cull against the POST-rotation screen position so the
            // rotated visible area is respected, not the axis-aligned
            // canvas rectangle in pre-rotation coords.
            let visX = p.x, visY = p.y;
            if (isRot) {
                const dx = p.x - rotCx, dy = p.y - rotCy;
                visX = dx * cosR - dy * sinR + rotCx;
                visY = dx * sinR + dy * cosR + rotCy;
            }
            if (visX < -20 || visX > view.canvasW + 20 ||
                visY < -20 || visY > view.canvasH + 20) continue;

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
    document.getElementById('slider-wrap').classList.add('visible');
    document.getElementById('lock-toggles').classList.add('visible');
    document.getElementById('compass').classList.add('visible');

    if (NO_TIDE_MAPS.has(mapName)) {
        state.showCurrent = false;
        state.tideButton  = null;
    }
    // Disable the bottom-left "Current" toggle for maps without tide data.
    const cbtn = document.getElementById('lock-current-btn');
    cbtn.disabled = NO_TIDE_MAPS.has(mapName);
    cbtn.classList.toggle('disabled', NO_TIDE_MAPS.has(mapName));

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
    // Wind grid: load even if NO direction has been picked, falling back
    // to 'north' so user-dot boxes always have wind data to sample. The
    // canvas-wide arrow / heatmap overlay still keys off state.wind, so
    // an unselected wind layer remains invisible there.
    const windDir = state.wind || state._lockedWind || 'north';
    if (state.map) {
        try {
            const g = await loadWindBin(state.map, windDir);
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

    // Current grid: load whenever the map has tide data, regardless of
    // the show-current toggle, so mark tips can sample it.
    if (state.map && !NO_TIDE_MAPS.has(state.map)) {
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

    // Day time: full HH:MM:SS clock for race start + slider, modulo 24h.
    document.getElementById('hud-time').textContent = secsToHHMMSS(dayTimeSeconds());

    updateLegend();
    updateBlendIndicator();
    updateTideMarkers();
}

const ABBR = { ebb: 'Ebb', low: 'Low', flood: 'Flood', high: 'High' };

// -------------------------------------------------------------------------
// Tide markers on the right-side slider.  Replaces the old sidebar "tide"
// column: each of the 4 main tides gets a dot + label positioned along
// the slider track at the slider value where that tide actually falls
// (relative to race start).  Positions shift as the user changes race
// start / high tide; markers outside the slider's [0, MAX] range are
// hidden (so locked-mode's 1-hour window typically shows none or one).
// -------------------------------------------------------------------------
const TIDE_NAMES = ['ebb', 'low', 'flood', 'high'];

function updateTideMarkers() {
    const host = document.getElementById('tide-markers');
    if (!host) return;
    // Clear & rebuild.  4 markers max, so the cost is negligible.
    host.innerHTML = '';
    if (!state.map || NO_TIDE_MAPS.has(state.map)) return;

    const dayCycle = 86400;
    for (const name of TIDE_NAMES) {
        const offsetHrs = TIDE_HOUR_OFFSETS[name];          // -9,-6,-3,0
        const tideTime  = ((state.highTideSeconds + offsetHrs * 3600) % dayCycle + dayCycle) % dayCycle;
        let secs = ((tideTime - state.startSeconds) % 43200 + 43200) % 43200;
        if (secs > SLIDER_MAX_SEC) continue;                 // outside slider range

        const pctFromBottom = (secs / SLIDER_MAX_SEC) * 100;
        const hh = Math.floor(secs / 3600);
        const mm = Math.floor((secs % 3600) / 60);

        const el = document.createElement('div');
        el.className = 'tide-marker';
        el.style.bottom = pctFromBottom + '%';
        el.innerHTML =
            `<span class="tide-name">${name.toUpperCase()}</span>` +
            `<span class="tide-time">+${hh}:${String(mm).padStart(2, '0')}</span>`;
        host.appendChild(el);
    }
}

// -------------------------------------------------------------------------
// Locked mode + bottom-left wind/current toggles + blend indicator
// -------------------------------------------------------------------------

function enterLockedMode() {
    // Called early in init() (before state.wind has been applied from
    // the URL).  Just flip the body class so the sidebar hides without
    // a flash; the wind direction snapshot + toggle highlight happen
    // later via finaliseLockedMode().
    state.locked = true;
    document.body.classList.add('locked-mode');
    document.getElementById('blend-indicator').style.display = 'block';
}

// Called AFTER state.wind has been set from ?code= / ?wind=, so the
// URL-supplied direction is the one we remember as the "preselected"
// wind to come back to when the user toggles the layer off and on.
function finaliseLockedMode() {
    if (!state.locked) return;
    state._lockedWind = state.wind;
    refreshLockToggles();
}

function refreshLockToggles() {
    const wbtn = document.getElementById('lock-wind-btn');
    const cbtn = document.getElementById('lock-current-btn');
    if (wbtn) {
        wbtn.classList.toggle('active', !!state.wind);
        wbtn.textContent = state.wind ? 'Wind' : 'Wind';
    }
    if (cbtn) cbtn.classList.toggle('active', state.showCurrent);
}

// Bottom-left toggles are now active in BOTH default and locked mode;
// they're shown whenever a map is loaded.  In default mode the sidebar
// is also visible and provides the radio buttons for picking a wind
// direction / force / etc.; the toggle just controls layer visibility.
document.getElementById('lock-wind-btn').addEventListener('click', async () => {
    if (!state.map) return;
    state.wind = state.wind ? null : (state._lockedWind || 'north');
    document.querySelectorAll('.wind-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.wind === state.wind);
    });
    await refreshActiveLayers();
    refreshLockToggles();
    updateHud();
    render();
});

document.getElementById('lock-current-btn').addEventListener('click', async () => {
    if (!state.map || NO_TIDE_MAPS.has(state.map)) return;
    state.showCurrent = !state.showCurrent;
    state.tideButton = null;
    await refreshActiveLayers();
    refreshLockToggles();
    updateHud();
    render();
});

// Tidal-phase indicator: shows current blend weighting (e.g. EBB 30% | LOW 70%)
// in the top of the canvas whenever a map (with tide data) is loaded.
function updateBlendIndicator() {
    const root = document.getElementById('blend-indicator');
    if (!root) return;
    if (!state.map || NO_TIDE_MAPS.has(state.map)) {
        root.style.display = 'none';
        return;
    }
    const bs = getTideBlendStates(phaseNow());
    // Always show in locked mode — even at pure tide moments — so the
    // user has a stable readout of where they are in the cycle.
    root.style.display = 'block';

    // Layout rule (no jumping back to the left when a transitional tide
    // peaks): the slack states (LOW, HIGH) always sit on the LEFT side
    // of the bar, the flowing states (FLOOD, EBB) always sit on the
    // RIGHT.  The bar fill represents the FLOWING side's weight, so it
    // grows L→R during LOW→FLOOD / HIGH→EBB and shrinks R→L during
    // FLOOD→HIGH / EBB→LOW.  No mid-cycle label flip.
    const SLACK   = { low: true, high: true };
    let leftState, rightState, leftW, rightW;
    if (SLACK[bs.state1] && !SLACK[bs.state2]) {
        // Growing phase: slack → flowing.
        leftState  = bs.state1;  leftW  = bs.w1;     // 100 → 0 %
        rightState = bs.state2;  rightW = bs.w2;     //   0 → 100 %
    } else if (!SLACK[bs.state1] && SLACK[bs.state2]) {
        // Shrinking phase: flowing → slack.
        leftState  = bs.state2;  leftW  = bs.w2;     //   0 → 100 %
        rightState = bs.state1;  rightW = bs.w1;     // 100 → 0 %
    } else {
        // Fallback (shouldn't happen with the existing 4-state cycle).
        leftState  = bs.state1;  leftW  = bs.w1;
        rightState = bs.state2;  rightW = bs.w2;
    }

    document.getElementById('blend-fill').style.width = (rightW * 100).toFixed(1) + '%';
    document.getElementById('blend-pct-left').textContent  = Math.round(leftW  * 100) + '%';
    document.getElementById('blend-pct-right').textContent = Math.round(rightW * 100) + '%';
    document.getElementById('blend-lbl-left').textContent  = ABBR[leftState ].toUpperCase();
    document.getElementById('blend-lbl-right').textContent = ABBR[rightState].toUpperCase();
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

// Wind direction is now a true radio: clicking always selects that
// direction (no toggle-off via same-click).  The bottom-left "Wind"
// button handles layer on/off.
document.querySelectorAll('.wind-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        if (!state.map) return;
        state.wind = btn.dataset.wind;
        state._lockedWind = state.wind;       // remember as last-selected
        document.querySelectorAll('.wind-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.wind === state.wind);
        });
        await refreshActiveLayers();
        refreshLockToggles();
        updateHud();
        render();
    });
});

// Tide column was removed in the redesign — the 4 main tides are now
// visualised as markers on the right-side slider (see updateTideMarkers).
// state.tideButton stays in the state object for backward compatibility
// with code paths that read it, but it's no longer settable from the UI.

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

// Sidebar collapse / expand.
const sidebarEl       = document.getElementById('sidebar');
const collapseBtnEl   = document.getElementById('collapse-sidebar');
const expandBtnEl     = document.getElementById('expand-sidebar');

// Toggling the sidebar is a pure CSS / overlay change — the canvas is
// always full-screen behind it, so we must NOT refit or re-render here
// (that would discard the user's zoom / pan / rotation).
collapseBtnEl.addEventListener('click', e => {
    e.stopPropagation();
    document.body.classList.add('sidebar-hidden');
});

expandBtnEl.addEventListener('click', () => {
    document.body.classList.remove('sidebar-hidden');
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

// No-op shim: kept so existing call-sites (stepSlider, slider drag) still
// compile.  In the redesign there's no "tide button" to unpin — the slider
// itself drives which blend is shown via updateTideMarkers().
function unpinTide() {
    state.tideButton = null;
}
// Internal step is in SECONDS. The "5 min" buttons add/subtract 300.
// SLIDER_MAX_SEC defaults to 12 h (no course); when a course is loaded
// via ?code= the range narrows to 1 h.  Use setSliderMax() to change.
let SLIDER_MAX_SEC = 43200;

function setSliderMax(secs) {
    SLIDER_MAX_SEC = secs;
    const slider = document.getElementById('vert-slider');
    if (slider) slider.max = secs;
    if (state.sliderSeconds > secs) {
        state.sliderSeconds = secs;
        if (slider) slider.value = secs;
    }
    const lbl = document.getElementById('slider-top-label');
    if (lbl) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        lbl.textContent = '+' + (h > 0 ? h + 'h' : '') + (m > 0 ? m + 'm' : (h === 0 ? '0m' : ''));
    }
}
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
    // Scrubbing the time slider is meaningful only when the current
    // layer is visible — auto-enable it on the first drag (matches the
    // "TIMELINE" visual idea where the slider IS the tide playback).
    if (!state.showCurrent && state.map && !NO_TIDE_MAPS.has(state.map)) {
        state.showCurrent = true;
        refreshLockToggles();
    }
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
    // Ignore the right mouse button entirely: no pan, no dot drop.
    if (e.button === 2) return;
    canvasEl.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pointerPosCss(e));

    if (pointers.size === 1) {
        dragInfo = {
            pid: e.pointerId,
            sx: e.clientX, sy: e.clientY,
            panX: viewport.panX, panY: viewport.panY,
            tapCandidate: true,
            t0: performance.now()
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
        // Drag delta in CSS-pixel screen coords.  When the canvas is
        // rotated (course-up mode), we need to express that delta in
        // pre-rotation coords before adding it to viewport.pan*.
        let dsx = (e.clientX - dragInfo.sx) * dpr;
        let dsy = (e.clientY - dragInfo.sy) * dpr;
        // Once the user has moved more than a few pixels it's no longer
        // a tap — convert to a drag for good.
        if (dragInfo.tapCandidate &&
            Math.hypot(e.clientX - dragInfo.sx, e.clientY - dragInfo.sy) > 8) {
            dragInfo.tapCandidate = false;
        }
        if (view.rotation !== 0) {
            const cosR = Math.cos(-view.rotation);
            const sinR = Math.sin(-view.rotation);
            const rx = dsx * cosR - dsy * sinR;
            const ry = dsx * sinR + dsy * cosR;
            dsx = rx; dsy = ry;
        }
        viewport.panX = dragInfo.panX + dsx;
        viewport.panY = dragInfo.panY + dsy;
        render();
    } else if (pointers.size === 2 && pinchInfo) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        // Translate by midpoint delta.
        const dpr = window.devicePixelRatio || 1;
        // Midpoint translation (in pre-rotation coords).
        let dMidX = (midX - pinchInfo.midX) * dpr;
        let dMidY = (midY - pinchInfo.midY) * dpr;
        if (view.rotation !== 0) {
            const cosR = Math.cos(-view.rotation);
            const sinR = Math.sin(-view.rotation);
            const rx = dMidX * cosR - dMidY * sinR;
            const ry = dMidX * sinR + dMidY * cosR;
            dMidX = rx; dMidY = ry;
        }
        viewport.panX += dMidX;
        viewport.panY += dMidY;

        // Zoom centered on midpoint — same cursor-anchor math as wheel.
        const cv = cssToCanvas({ x: midX, y: midY });
        const before = screenToWorld(cv.x, cv.y);
        const factor = dist / pinchInfo.dist;
        viewport.scale = Math.max(0.05, Math.min(80, viewport.scale * factor));
        const after  = worldToScreen(before.x, before.y);
        const target = unrotateScreen(cv.x, cv.y);
        viewport.panX += target.x - after.x;
        viewport.panY += target.y - after.y;

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
    // Tap / single-click without significant movement → place or remove a
    // user dot at the cursor's world coords. Works for both desktop
    // left-click and mobile tap.
    if (dragInfo && dragInfo.pid === e.pointerId && dragInfo.tapCandidate
        && (performance.now() - dragInfo.t0) < 500) {
        // Undo any sub-threshold pan that crept in during the tap so the
        // view doesn't jiggle when the user just wants to drop a dot.
        viewport.panX = dragInfo.panX;
        viewport.panY = dragInfo.panY;
        toggleUserDotAtCss(dragInfo.sx, dragInfo.sy);
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchInfo = null;
    if (pointers.size === 0) {
        dragInfo = null;
        canvasEl.classList.remove('dragging');
    }
}

// Place or remove a user dot. Click within DOT_HIT_PX (CSS px) of an
// existing dot removes it; otherwise a new dot is dropped at the cursor.
function toggleUserDotAtCss(clientX, clientY) {
    if (!state.map) return;

    const cv  = cssToCanvas({ x: clientX, y: clientY });
    const dpr = window.devicePixelRatio || 1;
    const cx  = view.canvasW / 2, cy = view.canvasH / 2;
    const cosR = Math.cos(view.rotation), sinR = Math.sin(view.rotation);

    let hitIdx = -1, hitDist = Infinity;
    for (let i = 0; i < state.userDots.length; i++) {
        const d = state.userDots[i];
        const p = worldToScreen(d.x, d.y);
        let vx = p.x, vy = p.y;
        if (view.rotation !== 0) {
            const dx = p.x - cx, dy = p.y - cy;
            vx = dx * cosR - dy * sinR + cx;
            vy = dx * sinR + dy * cosR + cy;
        }
        const dist = Math.hypot((vx - cv.x) / dpr, (vy - cv.y) / dpr);
        if (dist < hitDist) { hitDist = dist; hitIdx = i; }
    }

    if (hitIdx >= 0 && hitDist <= DOT_HIT_PX) {
        state.userDots.splice(hitIdx, 1);
    } else {
        const w = screenToWorld(cv.x, cv.y);
        state.userDots.push({ x: w.x, y: w.y });
    }
    render();
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
    const after  = worldToScreen(before.x, before.y);      // pre-rotation
    const target = unrotateScreen(cv.x, cv.y);             // pre-rotation
    viewport.panX += target.x - after.x;
    viewport.panY += target.y - after.y;
    render();
}, { passive: false });

canvasEl.addEventListener('dblclick', () => {
    // Quick "reset view" — refit and re-render.
    if (!state.map) return;
    fitView();
    render();
});

// Suppress the browser's native context menu so right-click on the map
// is a no-op rather than popping up an unrelated menu.
canvasEl.addEventListener('contextmenu', e => e.preventDefault());

// Tap-to-collapse for the on-screen overlays: bottom-right info bar,
// top-right tide blend indicator, top-left HUD + legend.  Tap once to
// shrink to a small dot; tap the dot again to expand.  Stops the tap
// from bubbling to the canvas (which would otherwise drop a user dot).
function wireCollapsible(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('is-collapsible');
    el.addEventListener('click', e => {
        e.stopPropagation();
        el.classList.toggle('is-collapsed');
    });
}
['info-bar', 'blend-indicator', 'hud', 'legend'].forEach(wireCollapsible);

// -------------------------------------------------------------------------
// Tooltip
//
// Desktop (mouse / fine pointer):    tooltip follows the cursor on hover.
// Mobile  (touch / coarse pointer):  tap-to-show — a single short tap on
// the map shows the tooltip at the tap location until the user pans or
// taps again.  No persistent crosshair / centre tooltip anymore.
// -------------------------------------------------------------------------

const tooltipEl = document.getElementById('tooltip');
const IS_TOUCH  = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

function hideTooltip() {
    tooltipEl.style.display = 'none';
}

// -------------------------------------------------------------------------
// Mark tooltips — permanent per-mark wind/current readouts shown when a
// course is loaded.  One box per: SL midpoint, FL midpoint, every leg's
// rounding mark (arc centre), and every gate midpoint.  Rebuilt on every
// render() so they follow pan/zoom and update with the slider.
// -------------------------------------------------------------------------

const markTipsHost = document.getElementById('mark-tips');

function _compassFrom(d) { return ((-d * 180 / Math.PI) % 360 + 360) % 360; }

function _markTipHTML(worldX, worldY) {
    const b = MAPS[state.map];
    const n = state.gridSize;
    const gxF = (worldX - b.xmin) / (b.xmax - b.xmin) * (n - 1);
    const gyF = (worldY - b.ymin) / (b.ymax - b.ymin) * (n - 1);
    const inside = gxF >= 0 && gxF <= n - 1 && gyF >= 0 && gyF <= n - 1;

    const lines = [];

    // Always show wind, regardless of the wind toggle. Falls back to
    // 'north' so a freshly-dropped dot still gets a wind reading even
    // before the user has explicitly picked a direction.
    const windDir = state.wind || state._lockedWind || 'north';
    if (state.activeWindGrid) {
        let m, d;
        if (inside) {
            const s = bilinearSampleVector(state.activeWindGrid, n, gxF, gyF);
            if (s) { m = s.mag; d = s.dir; }
        } else {
            const fb = getFallbackWind(state.map, windDir);
            if (fb) { m = fb.mag; d = fb.dir; }
        }
        if (m !== undefined) {
            const kn = m * windMultiplier(state.windForce);
            lines.push(`<div><span class="lbl">W</span>${kn.toFixed(1)} kn | ${_compassFrom(d).toFixed(0)}°</div>`);
        }
    }

    // Always show current, regardless of the current toggle, as long as
    // the map has tide data and the mark is inside the grid.
    if (state.activeCurrentGrid && inside) {
        const s = bilinearSampleVector(state.activeCurrentGrid, n, gxF, gyF);
        if (s) {
            const kn = s.mag * CURRENT_MULTIPLIER;
            lines.push(`<div><span class="lbl">C</span>${kn.toFixed(2)} kn | ${_compassFrom(s.dir).toFixed(0)}°</div>`);
        }
    }
    return lines.length ? lines.join('') : null;
}

function updateMarkTips() {
    if (!markTipsHost) return;
    markTipsHost.innerHTML = '';

    if (!state.locked || !state.course || !state.map) return;

    const c = state.course;
    // Course-sequence order: start line, every leg's mark/gate in race
    // order, finish line last.  Drives z-index so earlier marks render
    // above later marks when their boxes overlap.
    const marks = [];
    if (c.SL) marks.push({
        x: (c.SL.leftX + c.SL.rightX) / 2,
        y: (c.SL.leftY + c.SL.rightY) / 2
    });
    if (c.Legs) for (const l of c.Legs) {
        if (l.isGate && l.gate) marks.push({
            x: (l.gate.leftX + l.gate.rightX) / 2,
            y: (l.gate.leftY + l.gate.rightY) / 2
        });
        else if (l.arc && l.arc.centerX !== undefined) marks.push({
            x: l.arc.centerX,
            y: l.arc.centerY
        });
    }
    if (c.FL && c.FL.leftX !== undefined) marks.push({
        x: (c.FL.leftX + c.FL.rightX) / 2,
        y: (c.FL.leftY + c.FL.rightY) / 2
    });

    const dpr = window.devicePixelRatio || 1;
    const cx = view.canvasW / 2, cy = view.canvasH / 2;
    const isRot = view.rotation !== 0;
    const cosR  = Math.cos(view.rotation), sinR = Math.sin(view.rotation);

    const N = marks.length;
    for (let i = 0; i < N; i++) {
        const m = marks[i];
        const html = _markTipHTML(m.x, m.y);
        if (!html) continue;

        // Pre-rotation screen position → POST-rotation (visual) position.
        const p = worldToScreen(m.x, m.y);
        let vx = p.x, vy = p.y;
        if (isRot) {
            const dx = p.x - cx, dy = p.y - cy;
            vx = dx * cosR - dy * sinR + cx;
            vy = dx * sinR + dy * cosR + cy;
        }

        const tip = document.createElement('div');
        tip.className = 'mark-tip';
        tip.innerHTML = html;
        tip.style.left = (vx / dpr) + 'px';
        tip.style.top  = (vy / dpr) + 'px';
        // Earliest mark on top → highest z-index.
        tip.style.zIndex = String(N - i);
        markTipsHost.appendChild(tip);
    }
}

// -------------------------------------------------------------------------
// User-placed dots (right-click on the map). Each dot shows the same
// wind/current readout as a course mark, anchored top-left at the dot.
// -------------------------------------------------------------------------

const userTipsHost = document.getElementById('user-tips');
const DOT_HIT_PX   = 14;          // CSS px — click within this radius removes

function drawUserDots(ctx) {
    if (!state.userDots || state.userDots.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const r   = 5 * dpr;
    ctx.save();
    ctx.fillStyle   = '#ff3b30';                     // red dot
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth   = 1.5 * dpr;
    for (const d of state.userDots) {
        const p = worldToScreen(d.x, d.y);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
    ctx.restore();
}

// After the mark-tips + user-tips DOM has been populated for this frame,
// run an O(n²) overlap pass: walk tips top-to-bottom and push any that
// overlap a previously-placed one straight down until they clear.  Keeps
// boxes from stacking on top of each other on small (mobile) viewports.
function resolveTipOverlaps() {
    const tips = Array.from(document.querySelectorAll('.mark-tip, .user-tip'));
    if (tips.length < 2) return;

    // Initial rects (post-CSS-transform).
    const rects = tips.map(t => t.getBoundingClientRect());

    // Process in top-down visual order.
    const order = tips.map((_, i) => i).sort((a, b) => rects[a].top - rects[b].top);

    for (let k = 1; k < order.length; k++) {
        const i = order[k];
        let r = tips[i].getBoundingClientRect();
        // Check against every earlier tip; push down by the largest needed shift.
        let need = 0;
        for (let m = 0; m < k; m++) {
            const j = order[m];
            const r2 = tips[j].getBoundingClientRect();
            const overlap = !(r.right < r2.left || r.left > r2.right
                            || r.bottom < r2.top || r.top > r2.bottom);
            if (overlap) {
                need = Math.max(need, r2.bottom - r.top + 2);
            }
        }
        if (need > 0) {
            const dpr = window.devicePixelRatio || 1;
            const currentTop = parseFloat(tips[i].style.top) || 0;
            // top is set in CSS px (with /dpr divisor in updateMarkTips/
            // updateUserTips), so the shift is also in CSS px.
            tips[i].style.top = (currentTop + need) + 'px';
        }
    }
}

function updateUserTips() {
    if (!userTipsHost) return;
    userTipsHost.innerHTML = '';
    if (!state.userDots || state.userDots.length === 0 || !state.map) return;

    const dpr  = window.devicePixelRatio || 1;
    const cx   = view.canvasW / 2, cy = view.canvasH / 2;
    const isR  = view.rotation !== 0;
    const cosR = Math.cos(view.rotation), sinR = Math.sin(view.rotation);

    for (const d of state.userDots) {
        const html = _markTipHTML(d.x, d.y);
        if (!html) continue;

        const p = worldToScreen(d.x, d.y);
        let vx = p.x, vy = p.y;
        if (isR) {
            const dx = p.x - cx, dy = p.y - cy;
            vx = dx * cosR - dy * sinR + cx;
            vy = dx * sinR + dy * cosR + cy;
        }
        const tip = document.createElement('div');
        tip.className = 'user-tip';
        tip.innerHTML = html;
        tip.style.left = (vx / dpr) + 'px';
        tip.style.top  = (vy / dpr) + 'px';
        userTipsHost.appendChild(tip);
    }
}

// -------------------------------------------------------------------------
// Bottom-right info bar: single-line summary of the loaded course.
// -------------------------------------------------------------------------

const infoBarEl = document.getElementById('info-bar');

// Pretty labels for the wind-direction radio values used in state.wind
// (e.g. "north_east" → "NE").
const WIND_LABEL = {
    north: 'N', north_east: 'NE', east: 'E', south_east: 'SE',
    south: 'S', south_west: 'SW', west: 'W', north_west: 'NW'
};

// Sum the straight-line leg distances in nautical miles.
function courseLengthNm() {
    const c = state.course;
    if (!c || !c.Legs || c.Legs.length === 0 || !c.SL) return 0;
    const slMidX = (c.SL.leftX + c.SL.rightX) / 2;
    const slMidY = (c.SL.leftY + c.SL.rightY) / 2;
    let totalM = 0;
    for (let i = 0; i < c.Legs.length; i++) {
        const leg = c.Legs[i];
        const sx = (typeof leg.startX === 'number') ? leg.startX : slMidX;
        const sy = (typeof leg.startY === 'number') ? leg.startY : slMidY;
        totalM += Math.hypot(leg.endX - sx, leg.endY - sy);
    }
    return totalM / 1852;
}

function updateInfoBar() {
    if (!infoBarEl) return;
    if (!state.course || !state.map) {
        infoBarEl.style.display = 'none';
        return;
    }
    const parts = [];
    parts.push(state.map);
    if (state.courseName) parts.push(state.courseName);
    const nm = courseLengthNm();
    if (nm > 0) parts.push(nm.toFixed(2) + ' nm');
    const dir = state.wind || state._lockedWind;
    if (dir && WIND_LABEL[dir]) parts.push(WIND_LABEL[dir]);
    if (state.windForce) parts.push(state.windForce);
    if (state.shiftMode) parts.push(state.shiftMode);

    infoBarEl.innerHTML = parts
        .map(s => `<span>${escapeHTML(s)}</span>`)
        .join('<span class="sep">|</span>');
    infoBarEl.style.display = 'block';
}

function escapeHTML(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// -------------------------------------------------------------------------
// Compass rose — rotates so the red arrow always points to true North.
// The canvas is rotated by `view.rotation` (course-up); the compass lives
// OUTSIDE that transform, so we apply the same rotation to the SVG rose
// to mirror the visual rotation of world coords.
// -------------------------------------------------------------------------

const compassRoseEl = document.getElementById('compass-rose');
const compassEl     = document.getElementById('compass');

function updateCompass() {
    if (!compassRoseEl) return;
    const deg = ((view.rotation || 0) * 180 / Math.PI).toFixed(1);
    compassRoseEl.setAttribute('transform', `rotate(${deg})`);
}

// Tap the compass to hide it; tap doesn't reach the canvas (so no dot
// is dropped underneath).  Once hidden it stays hidden until the page
// is reloaded — that's the spec for this widget.
if (compassEl) {
    compassEl.addEventListener('click', e => {
        e.stopPropagation();
        compassEl.classList.add('is-hidden');
    });
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
            parts.push(`<div><span class="lbl">Wind</span>${kn.toFixed(1)} kn | ${compassFrom(dir).toFixed(0)}°</div>`);
        }
    }
    if (hasCurr && insideGrid) {
        const s = bilinearSampleVector(state.activeCurrentGrid, n, gxF, gyF);
        if (s) {
            const kn = s.mag * CURRENT_MULTIPLIER;
            parts.push(`<div><span class="lbl">Current</span>${kn.toFixed(2)} kn | ${compassFrom(s.dir).toFixed(0)}°</div>`);
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
// Visitor Logging
// -------------------------------------------------------------------------
async function logVisitor() {
    // 1. Set default values in case the IP lookup is blocked
    let geoIp = "Blocked/Unknown";
    let geoCountry = "Unknown";
    let geoRegion = "Unknown";
    let geoCity = "Unknown";

    // 2. Attempt the IP lookup (This is what usually gets blocked)
    try {
        const geoRes = await fetch('https://ipapi.co/json/');
        if (geoRes.ok) {
            const geoData = await geoRes.json();
            geoIp = geoData.ip || geoIp;
            geoCountry = geoData.country_name || geoCountry;
            geoRegion = geoData.region || geoRegion;
            geoCity = geoData.city || geoCity;
        }
    } catch (err) {
        console.warn('[VTC] IP lookup blocked. Proceeding with partial log.');
    }

    // 3. Extract and format course data
    const rawWind = state.wind || state._lockedWind;
    const windDirStr = rawWind ? (WIND_LABEL[rawWind] || rawWind) : ''; 
    const lengthNm = courseLengthNm();
    const lengthStr = (state.course && lengthNm > 0) ? lengthNm.toFixed(2) + ' nm' : '';

    // 4. Prepare the final payload using whatever data survived
    const payload = {
        ip: geoIp,
        country: geoCountry,
        region: geoRegion,
        city: geoCity,
        userAgent: navigator.userAgent,
        location: state.map || '',
        courseName: state.courseName || '',
        length: lengthStr,
        windDir: windDirStr,
        windStrength: state.windForce || '',
        windShifts: state.shiftMode || '',
        url: window.location.href
    };

    // 5. Send to Google Apps Script Web App
    try {
        // REPLACE WITH YOUR ACTUAL WEB APP URL
        const scriptUrl = 'https://script.google.com/macros/s/AKfycbxfYZuSmiFCZzUcDcOK-FNRoyy6ka1VvKb1GPQjHbkpTLrKAK6LGBWg6stqh2U_wjJTlA/exec'; 
        
        await fetch(scriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.warn('[VTC] Failed to contact Google Apps Script log.');
    }
}

// -------------------------------------------------------------------------
// URL parameters (for future AHK launch).
// -------------------------------------------------------------------------

(async function init() {
    const params = new URLSearchParams(location.search);

    // Course payload is now passed as ?course=<base64url>. ?code= is kept
    // as a backwards-compatible alias for links generated by older AHK
    // builds that still ship with the original parameter name.
    let codeData = null;
    const codeStr = params.get('course') || params.get('code');
        if (codeStr) {
            try {
                // 1. Fix base64url padding/characters
                const b64 = codeStr.replace(/-/g, '+').replace(/_/g, '/');
                
                // 2. Decode to a raw binary string
                const binStr = atob(b64);
                
                // 3. Convert the binary string into an array of UTF-8 bytes
                const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
                
                // 4. Properly decode those bytes back into a JavaScript string
                const json = new TextDecoder('utf-8').decode(bytes);
                
                codeData = JSON.parse(json);
            } catch (e) {
                console.warn('Bad ?course= payload:', e);
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
    // Course (sent by the AHK app inside the base64 payload).
    // When a course is present, narrow the slider to 1 hour AND enter
    // locked / read-only mode: the sidebar is hidden, only the slider +
    // two bottom-left toggles (Wind / Current) remain interactive.
    if (codeData && codeData.course && codeData.course.SL) {
        state.course = codeData.course;
        setSliderMax(3600);
        enterLockedMode();
    }

    // Course-meta fields piggy-backed on the payload.
    if (p('courseName')) state.courseName = String(p('courseName'));
    if (p('shiftMode'))  state.shiftMode  = String(p('shiftMode'));

    if (p('t') != null) {
        const t = parseInt(p('t'), 10) || 0;
        // URL param now interpreted as seconds (matches the slider).
        state.sliderSeconds = Math.max(0, Math.min(SLIDER_MAX_SEC, t));
        document.getElementById('vert-slider').value = state.sliderSeconds;
    }

    setCanvasSize();

    if (p('map') && MAPS[p('map')]) {
        if (p('wind')) state.wind = p('wind');
        if (p('tide')) state.showCurrent = true;       // legacy: turn current on
        await selectMap(p('map'));
        document.querySelectorAll('.wind-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.wind === state.wind);
        });
        // Capture the URL-supplied wind direction now that state.wind
        // is populated, and highlight the bottom-left "Wind" toggle.
        finaliseLockedMode();
    }

    updateHud();
	
	// Log the visitor (runs asynchronously in the background)
    logVisitor();
})();
