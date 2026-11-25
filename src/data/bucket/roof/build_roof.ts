import earcut from 'earcut';
import {buildRoofFrame, cross2, MIN_FRAME_EXTENT, minimumCorner, type RoofFrame} from './roof_frame.ts';
import {
    buildRadialRoof,
    encodeRoofNormal,
    facetFraction,
    facetsForShape,
    facetWallProfile,
    resolveRoofHeight,
    type HalfPlane,
    type PitchedRoofShape,
    type RoofFacet,
    type RoofInput,
    type RoofMesh,
    type WallStop,
} from './roof_shapes.ts';

import type Point from '@mapbox/point-geometry';

export type RoofGeometry = RoofMesh & {
    roofHeight: number;
    wallProfile: (a: Point, b: Point) => WallStop[];
};

type UV = [number, number];
type MeshVertex = [number, number, number, number, number, number];
type AxisBound = {axis: 0 | 1; bound: number; sign: 1 | -1};

const MAX_VERTICES = 10000;
const CLIPPED_CAP_FRACTION = 0.5;
const MIN_AREA = 1e-6;
const CLIP_BOUNDS_EPSILON = 1e-4;
const LINEAR_VERTEX_LIMIT = 192;

const IDENTITY_FRAME: RoofFrame = {center: [0, 0], axisX: [1, 0], axisY: [0, 1], halfLength: 0, halfWidth: 0};

function levelWallProfile(fraction: number): RoofGeometry['wallProfile'] {
    return (a, b) => [{point: a, fraction}, {point: b, fraction}];
}

const eaveWallProfile = levelWallProfile(0);

/** Clips `polygon` against the half-plane `signedDistance(v, plane) <= 0`. */
export function clipPolygon<V, P>(
    polygon: V[],
    plane: P,
    signedDistance: (vertex: V, plane: P) => number,
    interpolate: (p: V, q: V, t: number, plane: P) => V,
): V[] {
    if (polygon.length < 3) return [];

    const first = signedDistance(polygon[0], plane);
    let i = 1;
    while (i < polygon.length && (signedDistance(polygon[i], plane) <= 0) === (first <= 0)) i++;
    if (i === polygon.length) return first <= 0 ? polygon : [];

    const result: V[] = [];
    let fp = first;
    for (let k = 0; k < polygon.length; k++) {
        const p = polygon[k];
        const q = polygon[(k + 1) % polygon.length];
        const fq = k + 1 === polygon.length ? first : signedDistance(q, plane);
        if (fp <= 0) result.push(p);
        if (fp < 0 && fq > 0) result.push(interpolate(p, q, fp / (fp - fq), plane));
        else if (fp > 0 && fq < 0) result.push(interpolate(q, p, fq / (fq - fp), plane));
        fp = fq;
    }
    return result;
}

function halfPlaneDistance(p: UV, h: HalfPlane): number {
    return h.a * p[0] + h.b * p[1] + h.c;
}

function interpolateUV(p: UV, q: UV, t: number): UV {
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

function signedAreaUV(polygon: UV[]): number {
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i];
        const q = polygon[(i + 1) % polygon.length];
        area += cross2(p[0], p[1], q[0], q[1]);
    }
    return area / 2;
}

function pushFacetVertex(
    mesh: RoofMesh,
    u: number,
    v: number,
    facet: RoofFacet,
    normal: [number, number, number],
    frame: RoofFrame,
    ox: number,
    oy: number,
): number {
    const index = mesh.positions.length / 2;
    mesh.positions.push(
        frame.center[0] + u * frame.axisX[0] + v * frame.axisY[0] + ox,
        frame.center[1] + u * frame.axisX[1] + v * frame.axisY[1] + oy,
    );
    mesh.fractions.push(facetFraction(facet, u, v));
    mesh.normals.push(normal[0], normal[1], normal[2]);
    return index;
}

function facetVertexIndex(
    mesh: RoofMesh,
    u: number,
    v: number,
    facet: RoofFacet,
    normal: [number, number, number],
    frame: RoofFrame,
    ox: number,
    oy: number,
    coords: number[],
    overflow: Map<string, number> | undefined,
): number {
    if (overflow) {
        const key = `${u},${v}`;
        const existing = overflow.get(key);
        if (existing !== undefined) return existing;
        const index = pushFacetVertex(mesh, u, v, facet, normal, frame, ox, oy);
        overflow.set(key, index);
        return index;
    }
    for (let i = 0; i < coords.length; i += 3) {
        if (coords[i] === u && coords[i + 1] === v) return coords[i + 2];
    }
    const index = pushFacetVertex(mesh, u, v, facet, normal, frame, ox, oy);
    coords.push(u, v, index);
    return index;
}

/** Tessellates `footprint` by clipping earcut triangles against each facet's half-plane region. */
export function buildFacetRoof(
    footprint: Point[][],
    facets: RoofFacet[],
    frame: RoofFrame,
    roofHeightMetres: number,
    metersPerTileUnit: number,
    ox = 0,
    oy = 0,
): RoofMesh {
    const mesh: RoofMesh = {positions: [], fractions: [], normals: [], indices: []};
    const flat: number[] = [];
    const holeIndices: number[] = [];
    for (let r = 0; r < footprint.length; r++) {
        if (r > 0) holeIndices.push(flat.length / 2);
        const ring = footprint[r];
        for (let i = 0; i < ring.length - 1; i++) {
            const dx = (ring[i].x - ox) - frame.center[0];
            const dy = (ring[i].y - oy) - frame.center[1];
            flat.push(dx * frame.axisX[0] + dy * frame.axisX[1], dx * frame.axisY[0] + dy * frame.axisY[1]);
        }
    }

    const triangles = earcut(flat, holeIndices);
    const handedness = cross2(frame.axisX[0], frame.axisX[1], frame.axisY[0], frame.axisY[1]);
    const normalScale = roofHeightMetres > 0 ? 1 : 0;

    const triUVs: Array<[UV, UV, UV]> = new Array(triangles.length / 3);
    for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t] * 2;
        const b = triangles[t + 1] * 2;
        const c = triangles[t + 2] * 2;
        triUVs[t / 3] = [[flat[a], flat[a + 1]], [flat[b], flat[b + 1]], [flat[c], flat[c + 1]]];
    }

    for (const facet of facets) {
        const gradX = facet.gu * frame.axisX[0] + facet.gv * frame.axisY[0];
        const gradY = facet.gu * frame.axisX[1] + facet.gv * frame.axisY[1];
        const normal = encodeRoofNormal(-gradX / metersPerTileUnit, -gradY / metersPerTileUnit, 1, normalScale);
        const region = facet.region;
        const coords: number[] = [];
        let overflow: Map<string, number> | undefined;

        for (const triangle of triUVs) {
            let outside = false;
            for (const h of region) {
                if (halfPlaneDistance(triangle[0], h) > 0 && halfPlaneDistance(triangle[1], h) > 0 && halfPlaneDistance(triangle[2], h) > 0) {
                    outside = true;
                    break;
                }
            }
            if (outside) continue;

            let piece: UV[] = triangle;
            for (let r = 0; r < region.length && piece.length >= 3; r++) {
                piece = clipPolygon(piece, region[r], halfPlaneDistance, interpolateUV);
            }
            if (piece.length < 3) continue;

            const area = signedAreaUV(piece);
            if (Math.abs(area) < MIN_AREA) continue;

            if (!overflow && coords.length >= LINEAR_VERTEX_LIMIT) {
                overflow = new Map();
                for (let i = 0; i < coords.length; i += 3) overflow.set(`${coords[i]},${coords[i + 1]}`, coords[i + 2]);
            }

            const ccw = area * handedness > 0;
            const v0 = facetVertexIndex(mesh, piece[0][0], piece[0][1], facet, normal, frame, ox, oy, coords, overflow);
            let prev = facetVertexIndex(mesh, piece[1][0], piece[1][1], facet, normal, frame, ox, oy, coords, overflow);
            for (let i = 1; i < piece.length - 1; i++) {
                const next = facetVertexIndex(mesh, piece[i + 1][0], piece[i + 1][1], facet, normal, frame, ox, oy, coords, overflow);
                if (v0 !== prev && prev !== next && next !== v0) {
                    if (ccw) mesh.indices.push(v0, next, prev);
                    else mesh.indices.push(v0, prev, next);
                }
                prev = next;
            }
        }
    }
    return mesh;
}

function ringAreaSum(rings: Point[][]): number {
    let area = 0;
    for (const ring of rings) {
        if (ring.length < 4) continue;
        const x0 = ring[0].x;
        const y0 = ring[0].y;
        let ringArea = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            ringArea += cross2(ring[i].x - x0, ring[i].y - y0, ring[i + 1].x - x0, ring[i + 1].y - y0);
        }
        area += Math.abs(ringArea) / 2;
    }
    return area;
}

function flatCap(footprint: Point[][], fraction: number, roofHeight: number, ox: number, oy: number): RoofGeometry {
    const facets: RoofFacet[] = [{z0: fraction, gu: 0, gv: 0, region: []}];
    const mesh = buildFacetRoof(footprint, facets, IDENTITY_FRAME, roofHeight, 1, ox, oy);
    return {...mesh, roofHeight, wallProfile: levelWallProfile(fraction)};
}

function buildPitchedRoof(
    footprint: Point[][],
    shape: PitchedRoofShape,
    frame: RoofFrame,
    roofHeight: number,
    metersPerTileUnit: number,
    ox: number,
    oy: number,
): RoofGeometry | null {
    let vertexCount = 0;
    for (const ring of footprint) vertexCount += ring.length - 1;
    if (vertexCount > MAX_VERTICES) return null;

    if (shape === 'dome' && footprint.length === 1) {
        const radial = buildRadialRoof(footprint[0], frame, roofHeight, metersPerTileUnit, ox, oy);
        if (radial) {
            if (radial.positions.length / 2 > MAX_VERTICES) return null;
            return {...radial, roofHeight, wallProfile: eaveWallProfile};
        }
    }

    const facets = facetsForShape(shape, frame);
    const mesh = buildFacetRoof(footprint, facets, frame, roofHeight, metersPerTileUnit, ox, oy);
    if (mesh.positions.length / 2 > MAX_VERTICES) return null;
    return {
        ...mesh,
        roofHeight,
        wallProfile: (a, b) => facetWallProfile(facets, frame, a, b, ox, oy),
    };
}

/**
 * Tessellates a building roof in tile coordinates relative to its minimum corner. Clipped pieces
 * without a shared `frame` (or with `dome`) fall back to a flat cap so adjacent tiles meet cleanly.
 */
export function buildRoof(input: RoofInput): RoofGeometry {
    const outer = input.footprint[0];
    if (!outer || outer.length < 4 || ringAreaSum(input.footprint) < MIN_AREA) {
        return {positions: [], fractions: [], normals: [], indices: [], roofHeight: 0, wallProfile: eaveWallProfile};
    }

    const [ox, oy] = minimumCorner(input.footprint);
    if (input.shape === 'flat') return flatCap(input.footprint, 0, 0, ox, oy);

    const followsSharedFrame = input.frame !== undefined && input.shape !== 'dome';
    if (input.clipped && !followsSharedFrame) {
        return input.roofHeight !== undefined && input.roofHeight > 0 ?
            flatCap(input.footprint, CLIPPED_CAP_FRACTION, input.roofHeight, ox, oy) :
            flatCap(input.footprint, 0, 0, ox, oy);
    }

    const frame = input.frame ?
        {...input.frame, center: [input.frame.center[0] - ox, input.frame.center[1] - oy] as [number, number]} :
        buildRoofFrame(input.footprint, input.direction, ox, oy);
    const roofHeight = resolveRoofHeight(input, frame);
    if (roofHeight <= 0 || frame.halfLength < MIN_FRAME_EXTENT || frame.halfWidth < MIN_FRAME_EXTENT) {
        return flatCap(input.footprint, 0, 0, ox, oy);
    }

    return buildPitchedRoof(input.footprint, input.shape, frame, roofHeight, input.metersPerTileUnit, ox, oy) ??
        flatCap(input.footprint, 0, 0, ox, oy);
}

function meshVertex(mesh: RoofMesh, index: number): MeshVertex {
    return [
        mesh.positions[index * 2], mesh.positions[index * 2 + 1],
        mesh.fractions[index],
        mesh.normals[index * 3], mesh.normals[index * 3 + 1], mesh.normals[index * 3 + 2],
    ];
}

function pushMeshVertex(mesh: RoofMesh, v: MeshVertex): number {
    mesh.positions.push(v[0], v[1]);
    mesh.fractions.push(v[2]);
    mesh.normals.push(v[3], v[4], v[5]);
    return mesh.positions.length / 2 - 1;
}

function keepMeshVertex(src: RoofMesh, dst: RoofMesh, kept: Int32Array, index: number): number {
    if (kept[index] >= 0) return kept[index];
    const mapped = pushMeshVertex(dst, meshVertex(src, index));
    kept[index] = mapped;
    return mapped;
}

function axisDistance(vertex: MeshVertex, {axis, bound, sign}: AxisBound): number {
    return sign * (vertex[axis] - bound);
}

function interpolateMeshVertex(p: MeshVertex, q: MeshVertex, t: number, {axis, bound}: AxisBound): MeshVertex {
    const cut: MeshVertex = [
        p[0] + (q[0] - p[0]) * t,
        p[1] + (q[1] - p[1]) * t,
        p[2] + (q[2] - p[2]) * t,
        p[3] + (q[3] - p[3]) * t,
        p[4] + (q[4] - p[4]) * t,
        p[5] + (q[5] - p[5]) * t,
    ];
    cut[axis] = bound;
    return cut;
}

/** Clips `mesh` to `[min, max]` on both axes, interpolating fraction and normal along cut edges. */
export function clipRoofMesh(mesh: RoofMesh, min: number, max: number): RoofMesh {
    const lo = min - CLIP_BOUNDS_EPSILON;
    const hi = max + CLIP_BOUNDS_EPSILON;
    let allWithin = true;
    for (const coord of mesh.positions) {
        if (coord < lo || coord > hi) {
            allWithin = false;
            break;
        }
    }
    if (allWithin) return mesh;

    const bounds: AxisBound[] = [
        {axis: 0, bound: min, sign: -1},
        {axis: 0, bound: max, sign: 1},
        {axis: 1, bound: min, sign: -1},
        {axis: 1, bound: max, sign: 1},
    ];
    const clipped: RoofMesh = {positions: [], fractions: [], normals: [], indices: []};
    const kept = new Int32Array(mesh.fractions.length).fill(-1);

    for (let t = 0; t < mesh.indices.length; t += 3) {
        const a = mesh.indices[t];
        const b = mesh.indices[t + 1];
        const c = mesh.indices[t + 2];
        const ax = mesh.positions[a * 2];
        const ay = mesh.positions[a * 2 + 1];
        const bx = mesh.positions[b * 2];
        const by = mesh.positions[b * 2 + 1];
        const cx = mesh.positions[c * 2];
        const cy = mesh.positions[c * 2 + 1];
        if (ax >= lo && ax <= hi && ay >= lo && ay <= hi &&
            bx >= lo && bx <= hi && by >= lo && by <= hi &&
            cx >= lo && cx <= hi && cy >= lo && cy <= hi) {
            clipped.indices.push(
                keepMeshVertex(mesh, clipped, kept, a),
                keepMeshVertex(mesh, clipped, kept, b),
                keepMeshVertex(mesh, clipped, kept, c),
            );
            continue;
        }

        let polygon: MeshVertex[] = [meshVertex(mesh, a), meshVertex(mesh, b), meshVertex(mesh, c)];
        for (const bound of bounds) polygon = clipPolygon(polygon, bound, axisDistance, interpolateMeshVertex);
        if (polygon.length < 3) continue;

        const base = clipped.positions.length / 2;
        for (const vertex of polygon) pushMeshVertex(clipped, vertex);
        for (let i = 1; i < polygon.length - 1; i++) clipped.indices.push(base, base + i, base + i + 1);
    }
    return clipped;
}
