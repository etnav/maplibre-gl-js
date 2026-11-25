import Point from '@mapbox/point-geometry';
import {findPoleOfInaccessibility} from '../../../util/find_pole_of_inaccessibility.ts';
import {cross2, MIN_FRAME_EXTENT, type RoofFrame} from './roof_frame.ts';

import type {Feature} from '@maplibre/maplibre-gl-style-spec';
import type {
    DataDrivenProperty,
    PossiblyEvaluated,
} from '../../../style/properties.ts';
import type {
    FillExtrusionLayoutProps,
    FillExtrusionLayoutPropsPossiblyEvaluated,
    FillExtrusionPaintProps,
    FillExtrusionPaintPropsPossiblyEvaluated,
} from '../../../style/style_layer/fill_extrusion_style_layer_properties.g.ts';
import type {CanonicalTileID} from '../../../tile/tile_id.ts';

export type RoofShape = FillExtrusionLayoutProps['fill-extrusion-roof-shape'] extends DataDrivenProperty<infer T> ? T : never;
export type PitchedRoofShape = Exclude<RoofShape, 'flat'>;

/** Roof cap mesh: tile-space `positions` (`x, y`), `fractions` in `[0, 1]`, packed `normals`, and triangle `indices`. */
export type RoofMesh = {
    positions: number[];
    fractions: number[];
    normals: number[];
    indices: number[];
};

export type RoofStyledLayer = {
    layout: PossiblyEvaluated<FillExtrusionLayoutProps, FillExtrusionLayoutPropsPossiblyEvaluated>;
    paint: PossiblyEvaluated<FillExtrusionPaintProps, FillExtrusionPaintPropsPossiblyEvaluated>;
};

export type RoofStyle = {
    shape: RoofShape;
    direction?: number;
    roofHeight?: number;
};

export type RoofInput = RoofStyle & {
    footprint: Point[][];
    metersPerTileUnit: number;
    frame?: RoofFrame;
    clipped?: boolean;
};

/** Half-plane `a * u + b * v + c <= 0` in local `(u, v)` coordinates. */
export type HalfPlane = {a: number; b: number; c: number};

export type RoofFacet = {
    z0: number;
    gu: number;
    gv: number;
    region: HalfPlane[];
};

export type RoofPlane = Omit<RoofFacet, 'region'>;

export type WallStop = {point: Point; fraction: number};

const DEFAULT_PITCH_BY_SHAPE: Record<RoofShape, number> = {
    flat: 0,
    skillion: Math.PI / 12,
    gabled: Math.PI / 6,
    hipped: Math.PI / 6,
    half_hipped: Math.PI / 6,
    pyramidal: Math.PI / 6,
    mansard: Math.PI / 4,
    gambrel: Math.PI / 4,
    saltbox: Math.PI / 6,
    round: Math.PI / 6,
    dome: Math.PI / 4,
};

const MANSARD = {inset: 0.3, breakFraction: 0.75};
const GAMBREL = {inset: 0.35, breakFraction: 0.6};
const HALF_HIP_FRACTION = 0.5;
const SALTBOX_RIDGE_DIVISOR = 3;
const ROUND_SEGMENTS = 12;
const DOME_RINGS = 8;
const POLE_PRECISION = 0.5;

const EPSILON_1E6 = 1e-6;
const HALF_PLANE_TOLERANCE = 1e-7;
const STAR_CROSS_EPSILON = 1e-8;
const EPSILON_1E9 = 1e-9;
const EPSILON_1E12 = 1e-12;

/** Minimum non-zero `normal.z` (`2^-13`) so vertical roof faces still use `fill-extrusion-roof-color`. */
const MIN_NORMAL_Z = 1 / 8192;

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function evaluateRoofStyle(
    feature: Feature,
    {layout, paint}: RoofStyledLayer,
    canonical?: CanonicalTileID,
): RoofStyle {
    const rawShape = layout.get('fill-extrusion-roof-shape').evaluate(feature, {}, canonical);
    const shape: RoofShape = typeof rawShape === 'string' && Object.hasOwn(DEFAULT_PITCH_BY_SHAPE, rawShape) ? rawShape : 'flat';
    return {
        shape,
        direction: finiteNumber(layout.get('fill-extrusion-roof-direction').evaluate(feature, {}, canonical)),
        roofHeight: finiteNumber(paint.get('fill-extrusion-roof-height').evaluate(feature, {}, canonical)),
    };
}

export function resolveRoofHeight(input: RoofInput, frame: RoofFrame): number {
    if (input.roofHeight !== undefined) return Math.max(0, input.roofHeight);
    const span = input.shape === 'skillion' ? 2 * frame.halfWidth : Math.min(frame.halfLength, frame.halfWidth);
    return span * input.metersPerTileUnit * Math.tan(DEFAULT_PITCH_BY_SHAPE[input.shape]);
}

/** Packs `(nx, ny, nz)` into `[-1, 1]` with `xy` pre-divided by roof height so the shader can rescale live. */
export function encodeRoofNormal(nx: number, ny: number, nz: number, roofHeightMetres: number): [number, number, number] {
    if (roofHeightMetres <= 0) return [0, 0, 1];
    const x = nx / roofHeightMetres;
    const y = ny / roofHeightMetres;
    const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(nz));
    if (scale < EPSILON_1E12) return [0, 0, 1];
    const scaledZ = nz / scale;
    const z = Math.abs(scaledZ) < MIN_NORMAL_Z ? (scaledZ < 0 ? -MIN_NORMAL_Z : MIN_NORMAL_Z) : scaledZ;
    return [x / scale, y / scale, z];
}

function isSamePlane(p: RoofPlane, q: RoofPlane): boolean {
    return Math.abs(p.z0 - q.z0) < EPSILON_1E9 &&
        Math.abs(p.gu - q.gu) < EPSILON_1E9 &&
        Math.abs(p.gv - q.gv) < EPSILON_1E9;
}

/** Facets of the lower envelope of `planes`, each bounded by the half-planes where it lies lowest. */
export function lowerEnvelope(planes: RoofPlane[]): RoofFacet[] {
    const unique = planes.filter((plane, i) => planes.findIndex((other) => isSamePlane(other, plane)) === i);
    return unique.map((plane, i) => ({
        ...plane,
        region: unique
            .filter((_, j) => j !== i)
            .map((other) => ({a: plane.gu - other.gu, b: plane.gv - other.gv, c: plane.z0 - other.z0})),
    }));
}

/** Lower envelope for 1D convex profiles (`gu === 0`), where each strip only borders its immediate `v` neighbours. */
function vStripEnvelope(planes: RoofPlane[]): RoofFacet[] {
    const sorted = planes.slice().sort((a, b) => a.gv - b.gv);
    return sorted.map((p, i) => {
        const region: HalfPlane[] = [];
        if (i > 0) region.push({a: 0, b: p.gv - sorted[i - 1].gv, c: p.z0 - sorted[i - 1].z0});
        if (i + 1 < sorted.length) region.push({a: 0, b: p.gv - sorted[i + 1].gv, c: p.z0 - sorted[i + 1].z0});
        return {...p, region};
    });
}

function fallingFromRidgeV(halfExtent: number, slope: number, rise: number): RoofPlane[] {
    return [
        {z0: rise + slope * halfExtent, gu: 0, gv: -slope},
        {z0: rise + slope * halfExtent, gu: 0, gv: slope},
    ];
}

function fallingFromRidgeU(halfExtent: number, slope: number, rise: number): RoofPlane[] {
    return [
        {z0: rise + slope * halfExtent, gu: -slope, gv: 0},
        {z0: rise + slope * halfExtent, gu: slope, gv: 0},
    ];
}

function twoTierPlanes(halfWidth: number, halfLength: number | undefined, inset: number, breakFraction: number): RoofPlane[] {
    const span = halfLength === undefined ? halfWidth : Math.min(halfWidth, halfLength);
    const lower = breakFraction / inset;
    const upper = (1 - breakFraction) / (span - inset);
    const planes = [
        ...fallingFromRidgeV(halfWidth, lower, 0),
        ...fallingFromRidgeV(halfWidth - inset, upper, breakFraction),
    ];
    if (halfLength !== undefined) {
        planes.push(
            ...fallingFromRidgeU(halfLength, lower, 0),
            ...fallingFromRidgeU(halfLength - inset, upper, breakFraction),
        );
    }
    return planes;
}

function roundPlanes(halfWidth: number): RoofPlane[] {
    const planes: RoofPlane[] = [];
    for (let i = 0; i < ROUND_SEGMENTS; i++) {
        const t0 = (i / ROUND_SEGMENTS) * Math.PI;
        const t1 = ((i + 1) / ROUND_SEGMENTS) * Math.PI;
        const v0 = halfWidth * Math.cos(t0);
        const v1 = halfWidth * Math.cos(t1);
        const slope = (Math.sin(t1) - Math.sin(t0)) / (v1 - v0);
        planes.push({z0: Math.sin(t0) - slope * v0, gu: 0, gv: slope});
    }
    return planes;
}

/**
 * Facets of `shape` over `frame`, with roof fractions from 0 at the eaves to 1 at the peak. `dome`
 * returns pyramidal facets as the fallback for footprints that `buildRadialRoof` cannot cover.
 */
export function facetsForShape(shape: PitchedRoofShape, frame: RoofFrame): RoofFacet[] {
    const l = Math.max(frame.halfLength, MIN_FRAME_EXTENT);
    const w = Math.max(frame.halfWidth, MIN_FRAME_EXTENT);
    const span = Math.min(l, w);

    switch (shape) {
        case 'pyramidal':
        case 'dome':
            return lowerEnvelope([...fallingFromRidgeV(w, 1 / w, 0), ...fallingFromRidgeU(l, 1 / l, 0)]);
        case 'skillion':
            return [{z0: 0.5, gu: 0, gv: -1 / (2 * w), region: []}];
        case 'gabled':
            return vStripEnvelope(fallingFromRidgeV(w, 1 / w, 0));
        case 'hipped':
            return lowerEnvelope([...fallingFromRidgeV(w, 1 / span, 0), ...fallingFromRidgeU(l, 1 / span, 0)]);
        case 'half_hipped': {
            const raw = [...fallingFromRidgeV(w, 1 / w, 0), ...fallingFromRidgeU(l, 1 / w, HALF_HIP_FRACTION)];
            const peak = Math.min(1, HALF_HIP_FRACTION + l / w);
            const planes = peak > 0 && Math.abs(peak - 1) >= EPSILON_1E9 ?
                raw.map(({z0, gu, gv}) => ({z0: z0 / peak, gu: gu / peak, gv: gv / peak})) :
                raw;
            return lowerEnvelope(planes);
        }
        case 'mansard':
            return lowerEnvelope(twoTierPlanes(w, l, MANSARD.inset * span, MANSARD.breakFraction));
        case 'gambrel':
            return vStripEnvelope(twoTierPlanes(w, undefined, GAMBREL.inset * w, GAMBREL.breakFraction));
        case 'saltbox': {
            const ridge = -w / SALTBOX_RIDGE_DIVISOR;
            return vStripEnvelope([
                {z0: w / (w - ridge), gu: 0, gv: -1 / (w - ridge)},
                {z0: w / (w + ridge), gu: 0, gv: 1 / (w + ridge)},
            ]);
        }
        case 'round':
            return vStripEnvelope(roundPlanes(w));
    }
}

export function facetFraction(facet: RoofFacet, u: number, v: number): number {
    return Math.max(0, Math.min(1, facet.z0 + facet.gu * u + facet.gv * v));
}

function fractionAt(facets: RoofFacet[], u: number, v: number): number {
    for (const facet of facets) {
        let inside = true;
        for (const h of facet.region) {
            if (h.a * u + h.b * v + h.c > HALF_PLANE_TOLERANCE * (Math.abs(h.a) + Math.abs(h.b) + Math.abs(h.c) + 1)) {
                inside = false;
                break;
            }
        }
        if (inside) return facetFraction(facet, u, v);
    }
    return 0;
}

/** Wall profile stops from `a` to `b`, splitting at facet-boundary crossings. */
export function facetWallProfile(facets: RoofFacet[], frame: RoofFrame, a: Point, b: Point, ox: number, oy: number): WallStop[] {
    const ax = a.x - ox;
    const ay = a.y - oy;
    const bx = b.x - ox;
    const by = b.y - oy;
    const dxa = ax - frame.center[0];
    const dya = ay - frame.center[1];
    const dxb = bx - frame.center[0];
    const dyb = by - frame.center[1];
    const ua = dxa * frame.axisX[0] + dya * frame.axisX[1];
    const va = dxa * frame.axisY[0] + dya * frame.axisY[1];
    const ub = dxb * frame.axisX[0] + dyb * frame.axisX[1];
    const vb = dxb * frame.axisY[0] + dyb * frame.axisY[1];

    let startFraction = -1;
    let endFraction = -1;
    let crossings: number[] | undefined;

    for (const facet of facets) {
        let inStart = startFraction < 0;
        let inEnd = endFraction < 0;
        let t0 = 0;
        let t1 = 1;
        for (const h of facet.region) {
            const f0 = h.a * ua + h.b * va + h.c;
            const f1 = h.a * ub + h.b * vb + h.c;
            if (inStart || inEnd) {
                const tol = HALF_PLANE_TOLERANCE * (Math.abs(h.a) + Math.abs(h.b) + Math.abs(h.c) + 1);
                if (f0 > tol) inStart = false;
                if (f1 > tol) inEnd = false;
            }
            if (t1 < t0) continue;
            if (Math.abs(f1 - f0) < EPSILON_1E12) {
                if (f0 > 0) t1 = -1;
                continue;
            }
            const tCross = f0 / (f0 - f1);
            if (f1 > f0) t1 = Math.min(t1, tCross);
            else t0 = Math.max(t0, tCross);
        }
        if (inStart) startFraction = facetFraction(facet, ua, va);
        if (inEnd) endFraction = facetFraction(facet, ub, vb);
        if (t1 - t0 >= EPSILON_1E6) {
            if (t0 > EPSILON_1E6 && t0 < 1 - EPSILON_1E6) (crossings ??= []).push(t0);
            if (t1 > EPSILON_1E6 && t1 < 1 - EPSILON_1E6) (crossings ??= []).push(t1);
        }
    }

    const start: WallStop = {point: a, fraction: Math.max(0, startFraction)};
    const end: WallStop = {point: b, fraction: Math.max(0, endFraction)};
    if (!crossings) return [start, end];

    crossings.sort((x, y) => x - y);
    const du = ub - ua;
    const dv = vb - va;
    const stops = [start];
    let prev = 0;
    for (let i = 0; i < crossings.length; i++) {
        const t = crossings[i];
        if (i > 0 && t - prev <= EPSILON_1E6) continue;
        prev = t;
        const point = new Point(ax + (bx - ax) * t + ox, ay + (by - ay) * t + oy);
        stops.push({point, fraction: fractionAt(facets, ua + du * t, va + dv * t)});
    }
    stops.push(end);
    return stops;
}

/** Winding sign (`1` or `-1`) of `ring` around `(cx, cy)` when star-shaped, or `0` when not. */
function starSign(cx: number, cy: number, ring: Point[], ox: number, oy: number): number {
    let sign = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const cross = cross2((a.x - ox) - cx, (a.y - oy) - cy, (b.x - ox) - cx, (b.y - oy) - cy);
        if (Math.abs(cross) < STAR_CROSS_EPSILON) continue;
        const s = cross > 0 ? 1 : -1;
        if (sign === 0) sign = s;
        else if (sign !== s) return 0;
    }
    return sign;
}

/** Builds a quarter-sphere dome over `ring`, or returns `null` when `ring` is not star-shaped. */
export function buildRadialRoof(
    ring: Point[],
    frame: RoofFrame,
    roofHeightMetres: number,
    metersPerTileUnit: number,
    ox = 0,
    oy = 0,
): RoofMesh | null {
    let poleX = frame.center[0];
    let poleY = frame.center[1];
    let sign = starSign(poleX, poleY, ring, ox, oy);
    if (sign === 0) {
        const localRing = ox === 0 && oy === 0 ? ring : ring.map((p) => new Point(p.x - ox, p.y - oy));
        const pole = findPoleOfInaccessibility([localRing], POLE_PRECISION);
        poleX = pole.x;
        poleY = pole.y;
        sign = starSign(poleX, poleY, ring, ox, oy);
        if (sign === 0) return null;
    }

    const n = ring.length - 1;
    const positions: number[] = [];
    const fractions: number[] = [];
    for (let k = 0; k < DOME_RINGS; k++) {
        const phi = (k / DOME_RINGS) * (Math.PI / 2);
        const scale = Math.cos(phi);
        const fraction = Math.sin(phi);
        for (let i = 0; i < n; i++) {
            const p = ring[i];
            positions.push(
                poleX + ((p.x - ox) - poleX) * scale,
                poleY + ((p.y - oy) - poleY) * scale,
            );
            fractions.push(fraction);
        }
    }
    positions.push(poleX, poleY);
    fractions.push(1);

    const flip = sign > 0;
    const indices: number[] = [];
    for (let k = 0; k < DOME_RINGS - 1; k++) {
        for (let i = 0; i < n; i++) {
            const a = k * n + i;
            const b = k * n + (i + 1) % n;
            if (flip) indices.push(a, b + n, b, a, a + n, b + n);
            else indices.push(a, b, b + n, a, b + n, a + n);
        }
    }
    const top = (DOME_RINGS - 1) * n;
    const tip = DOME_RINGS * n;
    for (let i = 0; i < n; i++) {
        const next = top + (i + 1) % n;
        if (flip) indices.push(top + i, tip, next);
        else indices.push(top + i, next, tip);
    }

    const accumulated = new Float64Array(fractions.length * 3);
    for (let t = 0; t < indices.length; t += 3) {
        const ia = indices[t];
        const ib = indices[t + 1];
        const ic = indices[t + 2];
        const pax = positions[ia * 2] * metersPerTileUnit;
        const pay = positions[ia * 2 + 1] * metersPerTileUnit;
        const paz = fractions[ia];
        const e1x = positions[ib * 2] * metersPerTileUnit - pax;
        const e1y = positions[ib * 2 + 1] * metersPerTileUnit - pay;
        const e1z = fractions[ib] - paz;
        const e2x = positions[ic * 2] * metersPerTileUnit - pax;
        const e2y = positions[ic * 2 + 1] * metersPerTileUnit - pay;
        const e2z = fractions[ic] - paz;
        const nx = -(e1y * e2z - e1z * e2y);
        const ny = -(e1z * e2x - e1x * e2z);
        const nz = -(e1x * e2y - e1y * e2x);
        if (nx * nx + ny * ny + nz * nz < 1e-24) continue;
        for (let k = 0; k < 3; k++) {
            const v = indices[t + k] * 3;
            accumulated[v] += nx;
            accumulated[v + 1] += ny;
            accumulated[v + 2] += nz;
        }
    }

    if (ox !== 0 || oy !== 0) {
        for (let i = 0; i < positions.length; i += 2) {
            positions[i] += ox;
            positions[i + 1] += oy;
        }
    }

    const normalScale = roofHeightMetres > 0 ? 1 : 0;
    const normals: number[] = [];
    for (let v = 0; v < accumulated.length; v += 3) {
        const encoded = encodeRoofNormal(accumulated[v], accumulated[v + 1], accumulated[v + 2], normalScale);
        normals.push(encoded[0], encoded[1], encoded[2]);
    }

    return {positions, fractions, normals, indices};
}
