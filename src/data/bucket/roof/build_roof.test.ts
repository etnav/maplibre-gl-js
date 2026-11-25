import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {buildRoof, clipRoofMesh, type RoofGeometry} from './build_roof.ts';
import {buildOutlineFrame} from './roof_frame.ts';

import type {RoofInput, RoofMesh, RoofShape} from './roof_shapes.ts';

function rectangle(x0: number, y0: number, width: number, height: number): Point[][] {
    return [[
        new Point(x0, y0),
        new Point(x0 + width, y0),
        new Point(x0 + width, y0 + height),
        new Point(x0, y0 + height),
        new Point(x0, y0),
    ]];
}

function roofInput(shape: RoofShape, footprint: Point[][], overrides: Partial<RoofInput> = {}): RoofInput {
    return {shape, direction: 0, roofHeight: 5, footprint, metersPerTileUnit: 1, ...overrides};
}

function fractionAt(geo: RoofGeometry, x: number, y: number): number {
    for (let i = 0; i < geo.indices.length; i += 3) {
        const [a, b, c] = [geo.indices[i], geo.indices[i + 1], geo.indices[i + 2]];
        const [ax, ay, bx, by, cx, cy] = [a, b, c].flatMap((v) => [geo.positions[v * 2], geo.positions[v * 2 + 1]]);
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(det) < 1e-12) continue;
        const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const wc = 1 - wa - wb;
        if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
        return wa * geo.fractions[a] + wb * geo.fractions[b] + wc * geo.fractions[c];
    }
    throw new Error(`no roof triangle covers (${x}, ${y})`);
}

function capArea(geo: RoofGeometry): number {
    let area = 0;
    for (let i = 0; i < geo.indices.length; i += 3) {
        const [ax, ay, bx, by, cx, cy] = [0, 1, 2].flatMap((k) => [geo.positions[geo.indices[i + k] * 2], geo.positions[geo.indices[i + k] * 2 + 1]]);
        area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }
    return area;
}

function shadedNormal(geo: RoofGeometry, vertex: number): [number, number, number] {
    const x = geo.normals[vertex * 3] * geo.roofHeight;
    const y = geo.normals[vertex * 3 + 1] * geo.roofHeight;
    const z = geo.normals[vertex * 3 + 2];
    const len = Math.hypot(x, y, z);
    return [x / len, y / len, z / len];
}

const FACET_SHAPES: RoofShape[] = ['skillion', 'gabled', 'hipped', 'half_hipped', 'pyramidal', 'mansard', 'gambrel', 'saltbox', 'round'];

describe('buildRoof', () => {
    test.each(FACET_SHAPES)('%s covers the footprint exactly once, wound clockwise', (shape) => {
        const footprint = rectangle(0, 0, 40, 20);
        const geo = buildRoof(roofInput(shape, footprint));

        expect(capArea(geo)).toBeCloseTo(800, 6);
        for (let i = 0; i < geo.indices.length; i += 3) {
            const [ax, ay, bx, by, cx, cy] = [0, 1, 2].flatMap((k) => [geo.positions[geo.indices[i + k] * 2], geo.positions[geo.indices[i + k] * 2 + 1]]);
            expect((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)).toBeLessThanOrEqual(0);
        }
    });

    test('gabled rises from the eaves to a ridge along the long side', () => {
        const geo = buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20)));

        expect(fractionAt(geo, 20, 10)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 5, 10)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 20, 5)).toBeCloseTo(0.5, 6);
        expect(fractionAt(geo, 20, 0)).toBeCloseTo(0, 6);
        expect(fractionAt(geo, 20, 20)).toBeCloseTo(0, 6);
    });

    test('gabled raises its end walls to the ridge and keeps its side walls at the eave', () => {
        const geo = buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20)));

        const gableEnd = geo.wallProfile(new Point(0, 0), new Point(0, 20));
        expect(gableEnd.map(({point, fraction}) => [point.y, fraction])).toEqual([[0, 0], [10, 1], [20, 0]]);

        const side = geo.wallProfile(new Point(0, 0), new Point(40, 0));
        expect(side.map(({fraction}) => fraction)).toEqual([0, 0]);
    });

    test('gabled slopes are lit with their real pitch', () => {
        const geo = buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20)));

        const northVertex = Math.floor(geo.positions.findIndex((value, i) => i % 2 === 1 && value === 0) / 2);
        const [, ny, nz] = shadedNormal(geo, northVertex);
        expect(ny / nz).toBeCloseTo(-0.5, 6);
    });

    test('hipped keeps a ridge between hips of the same pitch as the sides', () => {
        const geo = buildRoof(roofInput('hipped', rectangle(0, 0, 40, 20)));

        expect(fractionAt(geo, 15, 10)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 25, 10)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 5, 10)).toBeCloseTo(0.5, 6);
        expect(fractionAt(geo, 20, 5)).toBeCloseTo(0.5, 6);
        expect(geo.wallProfile(new Point(0, 0), new Point(0, 20)).map(({fraction}) => fraction)).toEqual([0, 0]);
    });

    test('half-hipped walls its ends up to half the roof height', () => {
        const geo = buildRoof(roofInput('half_hipped', rectangle(0, 0, 40, 20)));

        const end = geo.wallProfile(new Point(0, 0), new Point(0, 20));
        expect(Math.max(...end.map(({fraction}) => fraction))).toBeCloseTo(0.5, 6);
        expect(fractionAt(geo, 20, 10)).toBeCloseTo(1, 6);
    });

    test('pyramidal rises to a single apex', () => {
        const geo = buildRoof(roofInput('pyramidal', rectangle(0, 0, 40, 20)));

        expect(fractionAt(geo, 20, 10)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 10, 10)).toBeCloseTo(0.5, 6);
        expect(fractionAt(geo, 20, 5)).toBeCloseTo(0.5, 6);
    });

    test('mansard and gambrel break between a steep lower and a shallow upper slope', () => {
        const mansard = buildRoof(roofInput('mansard', rectangle(0, 0, 40, 20)));
        expect(fractionAt(mansard, 20, 3)).toBeCloseTo(0.75, 6);
        expect(fractionAt(mansard, 3, 10)).toBeCloseTo(0.75, 6);
        expect(fractionAt(mansard, 20, 10)).toBeCloseTo(1, 6);

        const gambrel = buildRoof(roofInput('gambrel', rectangle(0, 0, 40, 20)));
        expect(fractionAt(gambrel, 20, 3.5)).toBeCloseTo(0.6, 6);
        expect(fractionAt(gambrel, 20, 10)).toBeCloseTo(1, 6);
        expect(Math.max(...gambrel.wallProfile(new Point(0, 0), new Point(0, 20)).map(({fraction}) => fraction))).toBeCloseTo(1, 6);
    });

    test('skillion falls towards the direction it faces', () => {
        const north = buildRoof(roofInput('skillion', rectangle(0, 0, 40, 20), {direction: 0}));
        expect(fractionAt(north, 20, 0)).toBeCloseTo(0, 6);
        expect(fractionAt(north, 20, 20)).toBeCloseTo(1, 6);

        const east = buildRoof(roofInput('skillion', rectangle(0, 0, 40, 20), {direction: 90}));
        expect(fractionAt(east, 40, 10)).toBeCloseTo(0, 6);
        expect(fractionAt(east, 0, 10)).toBeCloseTo(1, 6);
    });

    test('saltbox puts its ridge off-centre, with the long slope facing the direction', () => {
        const geo = buildRoof(roofInput('saltbox', rectangle(0, 0, 40, 30)));

        expect(fractionAt(geo, 20, 20)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 20, 15)).toBeLessThan(1);
        expect(fractionAt(geo, 20, 0)).toBeCloseTo(0, 6);
        expect(fractionAt(geo, 20, 30)).toBeCloseTo(0, 6);
    });

    test('round follows a half circle across the slope axis', () => {
        const geo = buildRoof(roofInput('round', rectangle(0, 0, 40, 20)));

        expect(fractionAt(geo, 20, 10)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 20, 5)).toBeCloseTo(Math.sin(Math.PI / 3), 6);
    });

    test('dome stacks rings from the eave to a tip over the centre', () => {
        const geo = buildRoof(roofInput('dome', rectangle(0, 0, 20, 20)));

        const tip = geo.fractions.indexOf(1);
        expect([geo.positions[tip * 2], geo.positions[tip * 2 + 1]]).toEqual([10, 10]);
        expect(shadedNormal(geo, tip)[2]).toBeCloseTo(1, 6);
        expect(geo.wallProfile(new Point(0, 0), new Point(0, 20)).map(({fraction}) => fraction)).toEqual([0, 0]);
        for (let v = 0; v < 4; v++) expect(geo.fractions[v]).toBe(0);
        for (let v = 0; v < geo.fractions.length; v++) {
            expect(Math.abs(geo.normals[v * 3 + 2])).toBeGreaterThanOrEqual(1 / 8192);
        }
    });

    test('dome falls back to a pyramid over a footprint with a courtyard', () => {
        const footprint = [...rectangle(0, 0, 40, 40), [...rectangle(15, 15, 10, 10)[0]].reverse()];
        const geo = buildRoof(roofInput('dome', footprint));

        expect(capArea(geo)).toBeCloseTo(1500, 6);
        expect(fractionAt(geo, 5, 20)).toBeCloseTo(0.25, 6);
    });

    test('a missing roof height is derived from the shape pitch', () => {
        const geo = buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20), {roofHeight: undefined}));

        expect(geo.roofHeight).toBeCloseTo(10 * Math.tan(Math.PI / 6), 6);
    });

    test('a clipped footprint gets a flat cap halfway up its roof, with the walls rising to meet it', () => {
        const geo = buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20), {clipped: true}));

        expect(geo.roofHeight).toBe(5);
        expect(new Set(geo.fractions)).toEqual(new Set([0.5]));
        expect(capArea(geo)).toBeCloseTo(800, 6);
        expect(geo.wallProfile(new Point(0, 0), new Point(0, 20)).map(({fraction}) => fraction)).toEqual([0.5, 0.5]);
    });

    test('flat, zero-height, and clipped roofs without a height get a flat cap at the extrusion height', () => {
        for (const geo of [
            buildRoof(roofInput('flat', rectangle(0, 0, 40, 20))),
            buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20), {roofHeight: 0})),
            buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20), {roofHeight: undefined, clipped: true})),
        ]) {
            expect(geo.roofHeight).toBe(0);
            expect(new Set(geo.fractions)).toEqual(new Set([0]));
            expect(capArea(geo)).toBeCloseTo(800, 6);
        }
    });

    test('a degenerate footprint has no roof', () => {
        const geo = buildRoof(roofInput('gabled', [[new Point(0, 0), new Point(5, 5), new Point(0, 0)]]));

        expect(geo.indices).toHaveLength(0);
    });

    test('an empty, zero-area or symmetric figure-eight footprint has no roof', () => {
        for (const footprint of [
            [],
            [[]],
            [[new Point(0, 0), new Point(10, 0), new Point(20, 0), new Point(30, 0), new Point(0, 0)]],
            [[new Point(0, 0), new Point(10, 10), new Point(10, 0), new Point(0, 10), new Point(0, 0)]],
        ]) {
            const geo = buildRoof(roofInput('gabled', footprint));

            expect(geo.positions).toHaveLength(0);
            expect(geo.indices).toHaveLength(0);
            expect(geo.roofHeight).toBe(0);
            expect(geo.wallProfile(new Point(0, 0), new Point(10, 0)).map(({fraction}) => fraction)).toEqual([0, 0]);
        }
    });

    test('a repeated vertex does not change the roof', () => {
        const footprint = [[
            new Point(0, 0), new Point(40, 0), new Point(40, 0), new Point(40, 20), new Point(0, 20), new Point(0, 0),
        ]];
        const geo = buildRoof(roofInput('gabled', footprint));

        expect(capArea(geo)).toBeCloseTo(800, 6);
        expect(fractionAt(geo, 20, 10)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 20, 5)).toBeCloseTo(0.5, 6);
    });

    test('a counter-clockwise footprint still gets a clockwise cap', () => {
        const footprint = [[...rectangle(0, 0, 40, 20)[0]].reverse()];
        const geo = buildRoof(roofInput('hipped', footprint));

        expect(capArea(geo)).toBeCloseTo(800, 6);
        for (let i = 0; i < geo.indices.length; i += 3) {
            const [ax, ay, bx, by, cx, cy] = [0, 1, 2].flatMap((k) => [geo.positions[geo.indices[i + k] * 2], geo.positions[geo.indices[i + k] * 2 + 1]]);
            expect((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)).toBeLessThanOrEqual(0);
        }
    });

    test('a translated footprint gets the same roof and walls, translated', () => {
        const atOrigin = buildRoof(roofInput('gabled', rectangle(0, 0, 40, 20), {direction: undefined}));

        for (const [dx, dy] of [[4000, 3000], [1e6, 1e6 + 7]]) {
            const moved = buildRoof(roofInput('gabled', rectangle(dx, dy, 40, 20), {direction: undefined}));

            expect(moved.positions).toHaveLength(atOrigin.positions.length);
            expect(moved.positions.map((value, i) => value - (i % 2 === 0 ? dx : dy))).toEqual(atOrigin.positions.map((value) => expect.closeTo(value, 6)));
            expect(moved.fractions).toEqual(atOrigin.fractions);
            expect(moved.normals).toEqual(atOrigin.normals);
            expect(moved.indices).toEqual(atOrigin.indices);
            expect(moved.roofHeight).toBe(atOrigin.roofHeight);

            const gableEnd = moved.wallProfile(new Point(dx, dy), new Point(dx, dy + 20));
            expect(gableEnd.map(({point, fraction}) => [point.x - dx, point.y - dy, fraction])).toEqual([
                [0, 0, 0],
                [0, expect.closeTo(10, 6), expect.closeTo(1, 6)],
                [0, 20, 0],
            ]);
        }
    });

    test('a roof above the vertex limit falls back to a flat cap at the extrusion height', () => {
        const underLimit = buildRoof(roofInput('dome', regularPolygon(1200, 50)));
        expect(underLimit.positions.length / 2).toBe(9601);
        expect(Math.max(...underLimit.fractions)).toBe(1);

        const overLimit = buildRoof(roofInput('dome', regularPolygon(1300, 50)));
        expect(overLimit.roofHeight).toBe(0);
        expect(new Set(overLimit.fractions)).toEqual(new Set([0]));
        expect(overLimit.indices).toHaveLength(3 * 1298);
        expect(overLimit.positions.length / 2).toBe(1300);
        expect(overLimit.wallProfile(new Point(0, 50), new Point(100, 50)).map(({fraction}) => fraction)).toEqual([0, 0]);
    });

    test('a clipped piece that follows the shared frame of its building gets its part of the facet roof', () => {
        const outline = rectangle(4000, 3000, 40, 20)[0];
        const frame = buildOutlineFrame(outline, undefined);
        const geo = buildRoof(roofInput('gabled', rectangle(4000, 3000, 10, 20), {direction: undefined, roofHeight: undefined, clipped: true, frame}));

        expect(geo.roofHeight).toBeCloseTo(10 * Math.tan(Math.PI / 6), 6);
        expect(capArea(geo)).toBeCloseTo(200, 6);
        expect(fractionAt(geo, 4005, 3010)).toBeCloseTo(1, 6);
        expect(fractionAt(geo, 4005, 3005)).toBeCloseTo(0.5, 6);

        const cut = geo.wallProfile(new Point(4010, 3000), new Point(4010, 3020));
        expect(cut.map(({point, fraction}) => [point.y, fraction])).toEqual([
            [3000, 0],
            [expect.closeTo(3010, 6), expect.closeTo(1, 6)],
            [3020, 0],
        ]);
    });

    test('a clipped piece of a radial roof gets a flat cap even with a shared frame', () => {
        const frame = buildOutlineFrame(rectangle(0, 0, 40, 40)[0], undefined);
        const geo = buildRoof(roofInput('dome', rectangle(0, 0, 20, 40), {clipped: true, frame}));

        expect(geo.roofHeight).toBe(5);
        expect(new Set(geo.fractions)).toEqual(new Set([0.5]));
        expect(capArea(geo)).toBeCloseTo(800, 6);
    });

    test('dome over an outline that no pole sees whole falls back to the pyramid', () => {
        const uShape = [[
            new Point(0, 0), new Point(30, 0), new Point(30, 30), new Point(20, 30), new Point(20, 10),
            new Point(10, 10), new Point(10, 30), new Point(0, 30), new Point(0, 0),
        ]];
        const dome = buildRoof(roofInput('dome', uShape, {direction: undefined}));
        const pyramid = buildRoof(roofInput('pyramidal', uShape, {direction: undefined}));

        expect(dome.positions).toEqual(pyramid.positions);
        expect(dome.fractions).toEqual(pyramid.fractions);
        expect(Math.max(...dome.fractions)).toBeCloseTo(2 / 3, 6);
        expect(capArea(dome)).toBeCloseTo(700, 6);
    });

    test('half-hipped shorter than half its width is rescaled to reach the full roof height', () => {
        const geo = buildRoof(roofInput('half_hipped', rectangle(0, 0, 8, 20), {direction: 0}));

        expect(fractionAt(geo, 4, 10)).toBeCloseTo(1, 6);
        const end = geo.wallProfile(new Point(0, 0), new Point(0, 20));
        expect(Math.max(...end.map(({fraction}) => fraction))).toBeCloseTo(0.5 / 0.9, 6);
    });

    test('builds the same roofs, value for value, for every shape over a few footprints', () => {
        const lShape = [[
            new Point(4000, 3000), new Point(4037, 3011), new Point(4031, 3032), new Point(4017, 3028),
            new Point(4014, 3039), new Point(3991, 3032), new Point(4000, 3000),
        ]];
        const courtyard = [...rectangle(0, 0, 40, 30), [...rectangle(12, 9, 13, 11)[0]].reverse()];
        const pentagon = [[new Point(10, 0), new Point(31, 6), new Point(27, 25), new Point(6, 29), new Point(0, 11), new Point(10, 0)]];
        const shapes: RoofShape[] = ['flat', ...FACET_SHAPES, 'dome'];

        const values: number[] = [];
        for (const footprint of [lShape, courtyard, pentagon]) {
            for (const shape of shapes) {
                for (const overrides of [
                    {direction: undefined, roofHeight: undefined},
                    {direction: 30, roofHeight: 6},
                    {direction: undefined, clipped: true, frame: buildOutlineFrame(footprint[0], undefined)},
                ]) {
                    const geo = buildRoof(roofInput(shape, footprint, {metersPerTileUnit: 0.7, ...overrides}));
                    values.push(geo.roofHeight, ...geo.positions, ...geo.fractions, ...geo.normals, ...geo.indices);
                    for (const ring of footprint) {
                        for (let i = 1; i < ring.length; i++) {
                            for (const {point, fraction} of geo.wallProfile(ring[i - 1], ring[i])) values.push(point.x, point.y, fraction);
                        }
                    }
                }
            }
        }

        expect(values).toHaveLength(GOLDEN_VALUE_COUNT);
        expect(digest(values)).toBe(GOLDEN_DIGEST);
    });
});

describe('clipRoofMesh', () => {
    test('returns an in-bounds mesh unchanged, drops an out-of-bounds mesh, and interpolates cut edges', () => {
        const inside: RoofMesh = {positions: [0, 0, 0, 8, 8, 0], fractions: [0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2]};
        expect(clipRoofMesh(inside, 0, 8)).toBe(inside);

        const outside: RoofMesh = {positions: [10, 10, 10, 18, 18, 10], fractions: [0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2]};
        expect(clipRoofMesh(outside, 0, 8)).toEqual({positions: [], fractions: [], normals: [], indices: []});

        const mesh: RoofMesh = {
            positions: [0, 0, 4, 0, 0, 4, 4, 4, 12, 4],
            fractions: [0, 0, 0, 0, 1],
            normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1],
            indices: [0, 2, 1, 1, 2, 3, 1, 3, 4],
        };
        const clipped = clipRoofMesh(mesh, 0, 8);

        expect(clipped.positions.slice(0, 8)).toEqual([0, 0, 0, 4, 4, 0, 4, 4]);
        expect(clipped.indices.slice(0, 6)).toEqual([0, 1, 2, 2, 1, 3]);
        expect(clipped.positions.length / 2).toBe(8);
        expect(clipped.indices).toHaveLength(12);

        const cutVertices = [4, 5, 6, 7].filter((v) => clipped.positions[v * 2] === 8);
        expect(cutVertices).toHaveLength(2);
        for (const v of cutVertices) {
            expect(clipped.fractions[v]).toBeCloseTo(0.5, 9);
            expect(clipped.normals[v * 3]).toBeCloseTo(0.5, 9);
        }
    });
});

const GOLDEN_VALUE_COUNT = 31626;
const GOLDEN_DIGEST = '5a73d0da';

function digest(values: number[]): string {
    const bytes = new Uint8Array(new Float64Array(values).buffer);
    let hash = 0x811c9dc5;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function regularPolygon(sides: number, radius: number): Point[][] {
    const ring: Point[] = [];
    for (let i = 0; i < sides; i++) {
        const angle = (-2 * Math.PI * i) / sides;
        ring.push(new Point(radius + radius * Math.cos(angle), radius + radius * Math.sin(angle)));
    }
    ring.push(ring[0]);
    return [ring];
}