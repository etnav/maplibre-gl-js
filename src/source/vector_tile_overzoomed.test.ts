import {describe, test, expect} from 'vitest';
import {GeoJSONWrapper} from '@maplibre/vt-pbf';
import {getSlicedPolygons, sliceVectorTileLayer} from './vector_tile_overzoomed.ts';
import {CanonicalTileID} from '../tile/tile_id.ts';

import type Point from '@mapbox/point-geometry';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

function buildingLayer(...footprints: Array<[number, number, number, number]>): VectorTileLayerLike {
    const layer = new GeoJSONWrapper(footprints.map(([x0, y0, x1, y1], i) => ({
        type: 3,
        geometry: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
        tags: {},
        id: i + 1,
    })), {version: 2, extent: 4096});
    layer.name = 'building';
    return layer;
}

function xRange(rings: Point[][]): [number, number] {
    const xs = rings.flat().map((p) => p.x);
    return [Math.min(...xs), Math.max(...xs)];
}

describe('sliceVectorTileLayer', () => {
    const maxZoomTileID = new CanonicalTileID(14, 0, 0);

    test('clips geometry the buffer past the target tile\'s borders and carries no sliced polygons by default', () => {
        const source = buildingLayer([900, 400, 1200, 500]);

        const sliced = sliceVectorTileLayer(source, maxZoomTileID, new CanonicalTileID(16, 0, 0));

        expect(xRange(sliced.feature(0).loadGeometry())).toEqual([3600, 4224]);
        expect(getSlicedPolygons(sliced.feature(0))).toBeUndefined();
    });

    test('carries a polygon the max-zoom tile holds whole uncut into the overzoomed tiles on both sides of a border', () => {
        const source = buildingLayer([900, 400, 1200, 500]);

        const left = sliceVectorTileLayer(source, maxZoomTileID, new CanonicalTileID(16, 0, 0), true);
        const right = sliceVectorTileLayer(source, maxZoomTileID, new CanonicalTileID(16, 1, 0), true);

        expect(getSlicedPolygons(left.feature(0))).toEqual({
            whole: [[[
                {x: 3600, y: 1600}, {x: 4800, y: 1600}, {x: 4800, y: 2000}, {x: 3600, y: 2000}, {x: 3600, y: 1600},
            ]]],
            pieces: [],
        });
        expect(xRange(getSlicedPolygons(right.feature(0)).whole[0])).toEqual([-496, 704]);
        expect(xRange(right.feature(0).loadGeometry())).toEqual([-128, 704]);
    });

    test('carries a whole polygon reaching tiles past the border uncut', () => {
        const source = buildingLayer([900, 600, 2100, 700]);

        const sliced = sliceVectorTileLayer(source, maxZoomTileID, new CanonicalTileID(18, 3, 2), true);

        expect(xRange(getSlicedPolygons(sliced.feature(0)).whole[0])).toEqual([2112, 21312]);
        expect(xRange(sliced.feature(0).loadGeometry())).toEqual([2112, 4224]);
    });

    test('sorts a polygon the max-zoom tile holds only a piece of into pieces, also where the slice does not cut it again', () => {
        const source = buildingLayer([-64, 400, 100, 500]);

        const sliced = sliceVectorTileLayer(source, maxZoomTileID, new CanonicalTileID(15, 0, 0), true);

        const {whole, pieces} = getSlicedPolygons(sliced.feature(0));
        expect(whole).toEqual([]);
        expect(pieces.map(xRange)).toEqual([[-128, 200]]);
    });
});
