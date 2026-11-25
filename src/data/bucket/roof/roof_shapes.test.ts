import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {FillExtrusionStyleLayer} from '../../../style/style_layer/fill_extrusion_style_layer.ts';
import {buildRoofFrame, type RoofFrame} from './roof_frame.ts';
import {
    buildRadialRoof,
    encodeRoofNormal,
    evaluateRoofStyle,
    facetsForShape,
    facetWallProfile,
    lowerEnvelope,
    resolveRoofHeight,
} from './roof_shapes.ts';

import type {Feature} from '@maplibre/maplibre-gl-style-spec';

function layerOf(layout: Record<string, unknown>, paint: Record<string, unknown> = {}): FillExtrusionStyleLayer {
    const layer = new FillExtrusionStyleLayer({id: 'roofs', type: 'fill-extrusion', source: 'buildings', layout, paint}, {});
    layer.recalculate(new EvaluationParameters(16), []);
    return layer;
}

function polygon(properties: Record<string, unknown>): Feature {
    return {type: 3, properties};
}

function frame40x20(): RoofFrame {
    return {center: [0, 0], axisX: [1, 0], axisY: [0, 1], halfLength: 20, halfWidth: 10};
}

describe('evaluateRoofStyle', () => {
    test('evaluates constant and data-driven values against the feature', () => {
        const layer = layerOf({
            'fill-extrusion-roof-shape': ['get', 'kind'],
            'fill-extrusion-roof-direction': ['get', 'bearing'],
        }, {
            'fill-extrusion-roof-height': ['get', 'rise'],
        });

        expect(evaluateRoofStyle(polygon({kind: 'gabled', bearing: 135, rise: 4}), layer)).toEqual({shape: 'gabled', direction: 135, roofHeight: 4});
    });

    test('defaults unset or unknown shapes to flat without direction or height', () => {
        expect(evaluateRoofStyle(polygon({}), layerOf({}))).toEqual({shape: 'flat', direction: undefined, roofHeight: undefined});

        const constant = layerOf({'fill-extrusion-roof-shape': 'tent'});
        const dataDriven = layerOf({'fill-extrusion-roof-shape': ['get', 'kind']});
        expect(evaluateRoofStyle(polygon({}), constant)).toMatchObject({shape: 'flat'});
        expect(evaluateRoofStyle(polygon({kind: 'tent'}), dataDriven)).toMatchObject({shape: 'flat'});
    });

    test('treats non-finite directions and heights, including numeric strings, as unset', () => {
        const dataDriven = layerOf({'fill-extrusion-roof-direction': ['get', 'value']}, {'fill-extrusion-roof-height': ['get', 'value']});

        for (const value of ['45', NaN, Infinity, true]) {
            const constant = layerOf({'fill-extrusion-roof-direction': value}, {'fill-extrusion-roof-height': value});
            expect(evaluateRoofStyle(polygon({}), constant)).toMatchObject({direction: undefined, roofHeight: undefined});
            expect(evaluateRoofStyle(polygon({value}), dataDriven)).toMatchObject({direction: undefined, roofHeight: undefined});
        }
    });
});

describe('resolveRoofHeight', () => {
    test('clamps explicit heights at zero and derives missing heights from shape pitch', () => {
        const footprint: Point[][] = [];

        expect(resolveRoofHeight({shape: 'flat', roofHeight: 3, footprint, metersPerTileUnit: 1}, frame40x20())).toBe(3);
        expect(resolveRoofHeight({shape: 'gabled', roofHeight: -3, footprint, metersPerTileUnit: 1}, frame40x20())).toBe(0);
        expect(resolveRoofHeight({shape: 'gabled', footprint, metersPerTileUnit: 2}, frame40x20())).toBeCloseTo(10 * 2 * Math.tan(Math.PI / 6), 9);
        expect(resolveRoofHeight({shape: 'mansard', footprint, metersPerTileUnit: 2}, frame40x20())).toBeCloseTo(10 * 2 * Math.tan(Math.PI / 4), 9);
        expect(resolveRoofHeight({shape: 'skillion', footprint, metersPerTileUnit: 2}, frame40x20())).toBeCloseTo(20 * 2 * Math.tan(Math.PI / 12), 9);
        expect(resolveRoofHeight({shape: 'flat', footprint, metersPerTileUnit: 1}, frame40x20())).toBe(0);
        expect(resolveRoofHeight({shape: 'gabled', footprint, metersPerTileUnit: 0}, frame40x20())).toBe(0);
    });
});

describe('encodeRoofNormal', () => {
    test('scales x and y by roof height, normalizes to unit max component, and clamps near-zero z', () => {
        expect(encodeRoofNormal(0, 0.5, 1, 2)).toEqual([0, 0.25, 1]);
        expect(encodeRoofNormal(0, 4, 1, 1)).toEqual([0, 1, 0.25]);
        expect(encodeRoofNormal(1, 0, 1e-6, 1)).toEqual([1, 0, 1 / 8192]);
        expect(encodeRoofNormal(1, 0, -1e-6, 1)).toEqual([1, 0, -1 / 8192]);
        expect(encodeRoofNormal(0.5, 0.5, 0.7, 0)).toEqual([0, 0, 1]);
        expect(encodeRoofNormal(0, 0, 0, 1)).toEqual([0, 0, 1]);
    });
});

describe('lowerEnvelope and facetWallProfile', () => {
    test('keeps one facet per distinct plane, bounded by every other plane', () => {
        const facets = lowerEnvelope([{z0: 1, gu: 0, gv: 0}, {z0: 1, gu: 0, gv: 0}, {z0: 2, gu: 1, gv: 0}]);

        expect(facets).toEqual([
            {z0: 1, gu: 0, gv: 0, region: [{a: -1, b: 0, c: -1}]},
            {z0: 2, gu: 1, gv: 0, region: [{a: 1, b: 0, c: 1}]},
        ]);
    });

    test('produces no interior stops on walls parallel to facet boundaries and clamps fractions outside facets', () => {
        const frame: RoofFrame = {center: [20, 10], axisX: [1, 0], axisY: [0, -1], halfLength: 20, halfWidth: 10};
        const gabled = lowerEnvelope([{z0: 1, gu: 0, gv: -0.1}, {z0: 1, gu: 0, gv: 0.1}]);

        expect(facetWallProfile(gabled, frame, new Point(0, 10), new Point(40, 10), 0, 0).map(({point, fraction}) => [point.x, point.y, fraction])).toEqual([[0, 10, 1], [40, 10, 1]]);
        expect(facetWallProfile(gabled, frame, new Point(0, 5), new Point(40, 5), 0, 0).map(({point, fraction}) => [point.x, point.y, fraction])).toEqual([[0, 5, 0.5], [40, 5, 0.5]]);

        const halfFrame: RoofFrame = {center: [0, 0], axisX: [1, 0], axisY: [0, 1], halfLength: 5, halfWidth: 5};
        const single = [{z0: 2, gu: 0, gv: 0, region: [{a: 1, b: 0, c: 0}]}];
        expect(facetWallProfile(single, halfFrame, new Point(-5, 0), new Point(5, 0), 0, 0).map(({point, fraction}) => [point.x, point.y, fraction])).toEqual([[-5, 0, 1], [0, 0, 1], [5, 0, 0]]);
    });

    test('rescales half-hipped hips that meet below the ridge so the peak reaches fraction 1', () => {
        const frame: RoofFrame = {center: [0, 0], axisX: [1, 0], axisY: [0, 1], halfLength: 4, halfWidth: 10};
        const facets = facetsForShape('half_hipped', frame);

        const alongRidge = facetWallProfile(facets, frame, new Point(0, 0), new Point(4, 0), 0, 0);
        const downSlope = facetWallProfile(facets, frame, new Point(0, 0), new Point(0, 10), 0, 0);

        expect(alongRidge[0].fraction).toBeCloseTo(1, 9);
        expect(alongRidge[alongRidge.length - 1].fraction).toBeCloseTo(0.5 / 0.9, 9);
        expect(downSlope[downSlope.length - 1].fraction).toBeCloseTo(0, 9);
    });
});

describe('buildRadialRoof', () => {
    test('scales a convex outline about the frame centre', () => {
        const ring = [new Point(0, 0), new Point(40, 0), new Point(40, 20), new Point(0, 20), new Point(0, 0)];
        const mesh = buildRadialRoof(ring, buildRoofFrame([ring], undefined), 5, 1);

        const tip = mesh.fractions.length - 1;
        expect(mesh.fractions[tip]).toBe(1);
        expect([mesh.positions[tip * 2], mesh.positions[tip * 2 + 1]]).toEqual([20, 10]);
        expect(mesh.positions.slice(0, 8)).toEqual([0, 0, 40, 0, 40, 20, 0, 20]);
        expect(mesh.positions.length / 2).toBe(8 * 4 + 1);
        expect(mesh.indices.length / 3).toBe(7 * 4 * 2 + 4);
    });

    test('falls back to the pole of inaccessibility for an L-shape and returns null for a non-star U-shape', () => {
        const lShape = [
            new Point(0, 0), new Point(30, 0), new Point(30, 10), new Point(10, 10),
            new Point(10, 30), new Point(0, 30), new Point(0, 0),
        ];
        const frame = buildRoofFrame([lShape], undefined);
        const mesh = buildRadialRoof(lShape, frame, 5, 1);

        expect(frame.center).toEqual([15, 15]);
        const tip = mesh.fractions.length - 1;
        expect(mesh.fractions[tip]).toBe(1);
        expect(mesh.positions[tip * 2]).toBeCloseTo(5.86, 2);
        expect(mesh.positions[tip * 2 + 1]).toBeCloseTo(5.86, 2);
        expect(mesh.positions.length / 2).toBe(8 * 6 + 1);
        expect(new Set(mesh.fractions).size).toBe(9);

        const uShape = [
            new Point(0, 0), new Point(30, 0), new Point(30, 30), new Point(20, 30), new Point(20, 10),
            new Point(10, 10), new Point(10, 30), new Point(0, 30), new Point(0, 0),
        ];
        expect(buildRadialRoof(uShape, buildRoofFrame([uShape], undefined), 5, 1)).toBeNull();
    });
});
