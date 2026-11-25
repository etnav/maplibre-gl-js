import type Point from '@mapbox/point-geometry';

/**
 * Local roof coordinate frame in tile units: `axisX` runs along the ridge and `axisY` faces the
 * main slope. Frames from a compass bearing vs. a convex hull have opposite handedness, so winding
 * checks use the sign of `cross2(axisX, axisY)`.
 */
export type RoofFrame = {
    center: [number, number];
    axisX: [number, number];
    axisY: [number, number];
    halfLength: number;
    halfWidth: number;
};

export const MIN_FRAME_EXTENT = 1e-6;

const MIN_AXIS_LENGTH = 1e-12;

function normalize2(x: number, y: number): [number, number] {
    const len = Math.hypot(x, y);
    return len < MIN_AXIS_LENGTH ? [1, 0] : [x / len, y / len];
}

export function cross2(ax: number, ay: number, bx: number, by: number): number {
    return ax * by - ay * bx;
}

export function convexHull(ring: Point[]): Point[] {
    if (ring.length === 0) return [];
    const sorted = ring.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const pts: Point[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const prev = pts[pts.length - 1];
        if (sorted[i].x !== prev.x || sorted[i].y !== prev.y) pts.push(sorted[i]);
    }
    if (pts.length <= 1) return pts;
    return halfHull(pts, 0, 1).concat(halfHull(pts, pts.length - 1, -1));
}

function halfHull(sorted: Point[], from: number, step: 1 | -1): Point[] {
    const chain: Point[] = [];
    for (let i = from; i >= 0 && i < sorted.length; i += step) {
        const p = sorted[i];
        while (chain.length >= 2) {
            const q = chain[chain.length - 1];
            const r = chain[chain.length - 2];
            if (cross2(q.x - r.x, q.y - r.y, p.x - q.x, p.y - q.y) > 0) break;
            chain.pop();
        }
        chain.push(p);
    }
    chain.pop();
    return chain;
}

/** Unit vector along the longer side of the minimum-area bounding rectangle of `hull`. */
function longAxisOfHull(hull: Point[], ox: number, oy: number): [number, number] {
    let bestArea = Infinity;
    let bestAxis: [number, number] = [1, 0];

    for (let i = 0; i < hull.length; i++) {
        const p0 = hull[i];
        const p1 = hull[(i + 1) % hull.length];
        const [ax, ay] = normalize2((p1.x - ox) - (p0.x - ox), (p1.y - oy) - (p0.y - oy));
        const {minU, maxU, minV, maxV} = projectedExtents(hull, ax, ay, -ay, ax, ox, oy);
        const length = maxU - minU;
        const width = maxV - minV;
        const area = length * width;
        if (area >= bestArea) continue;

        bestArea = area;
        bestAxis = length >= width ? [ax, ay] : [-ay, ax];
    }

    return bestAxis;
}

function projectedExtents(
    points: Point[],
    axX: number,
    axY: number,
    ayX: number,
    ayY: number,
    ox: number,
    oy: number,
) {
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of points) {
        const px = p.x - ox;
        const py = p.y - oy;
        const u = px * axX + py * axY;
        const v = px * ayX + py * ayY;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
    }
    return {minU, maxU, minV, maxV};
}

/**
 * Builds the roof frame of `footprint` relative to `(ox, oy)`. Uses `directionDeg` (degrees
 * clockwise from north) when set, otherwise the long axis of the minimum-area bounding rectangle.
 */
export function buildRoofFrame(
    footprint: Point[][],
    directionDeg: number | undefined,
    ox = 0,
    oy = 0,
): RoofFrame {
    const hull = convexHull(footprint[0] ?? []);

    let axisX: [number, number];
    let axisY: [number, number];
    if (directionDeg !== undefined) {
        const rad = (directionDeg * Math.PI) / 180;
        axisY = normalize2(Math.sin(rad), -Math.cos(rad));
        axisX = [-axisY[1], axisY[0]];
    } else {
        axisX = longAxisOfHull(hull, ox, oy);
        axisY = [-axisX[1], axisX[0]];
    }

    if (hull.length === 0) {
        return {center: [0, 0], axisX, axisY, halfLength: 0, halfWidth: 0};
    }

    const {minU, maxU, minV, maxV} = projectedExtents(hull, axisX[0], axisX[1], axisY[0], axisY[1], ox, oy);
    const cu = (minU + maxU) / 2;
    const cv = (minV + maxV) / 2;
    return {
        center: [axisX[0] * cu + axisY[0] * cv, axisX[1] * cu + axisY[1] * cv],
        axisX,
        axisY,
        halfLength: (maxU - minU) / 2,
        halfWidth: (maxV - minV) / 2,
    };
}

export function minimumCorner(rings: Point[][]): [number, number] {
    let minX = Infinity;
    let minY = Infinity;
    for (const ring of rings) {
        for (const p of ring) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
        }
    }
    return Number.isFinite(minX) && Number.isFinite(minY) ? [minX, minY] : [0, 0];
}

/** Builds a roof frame from unclipped outline vertices, origin-shifted so adjacent tiles agree. */
export function buildOutlineFrame(outline: Point[], directionDeg: number | undefined): RoofFrame {
    const [minX, minY] = minimumCorner([outline]);
    const frame = buildRoofFrame([outline], directionDeg, minX, minY);
    return {...frame, center: [frame.center[0] + minX, frame.center[1] + minY]};
}

export function toLocalUV(frame: RoofFrame, x: number, y: number): [number, number] {
    const dx = x - frame.center[0];
    const dy = y - frame.center[1];
    return [dx * frame.axisX[0] + dy * frame.axisX[1], dx * frame.axisY[0] + dy * frame.axisY[1]];
}
