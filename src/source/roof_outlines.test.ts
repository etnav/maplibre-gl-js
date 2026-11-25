import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {GeoJSONWrapper} from '@maplibre/vt-pbf';
import {EXTENT} from '../data/extent.ts';
import {DEFAULT_TILE_BUFFER} from '../data/extent_bounds.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {CanonicalTileID} from '../tile/tile_id.ts';
import {featuresNeedingOutlines, gatherRoofOutlines, holdsPieceOf, outlinesInSlice, type TileLoader} from './roof_outlines.ts';

import type {VectorTileLike} from '@maplibre/vt-pbf';

describe('featuresNeedingOutlines', () => {
    test('asks for the buildings a layer draws with a pitched roof that some tile holds only a piece of', () => {
        const tile = buildingTile({
            1: rectangle(3796, 1000, 4160, 1400),
            2: rectangle(1000, 1000, 1400, 1400),
            3: rectangle(3796, 2000, 4160, 2400),
            4: rectangle(3796, 3000, 4160, 3400),
        });
        const families = new StyleLayerIndex([{
            id: 'buildings',
            source: 'source',
            'source-layer': 'building',
            type: 'fill-extrusion',
            filter: ['!=', ['id'], 4],
            layout: {'fill-extrusion-roof-shape': ['match', ['id'], 3, 'flat', 'gabled']},
        }]).familiesBySource.source;

        const request = featuresNeedingOutlines(tile, families, 14, new CanonicalTileID(14, 0, 0), undefined, [],
            (feature) => holdsPieceOf(feature, DEFAULT_TILE_BUFFER));

        expect(request).toEqual({building: new Set(['1'])});
    });
});

describe('gatherRoofOutlines', () => {
    test('gathers a building cut by a tile border from the pieces in both tiles, alike in each', async () => {
        const tiles = {
            '14/0/0': buildingTile({1: rectangle(3796, 1000, 4160, 1400)}),
            '14/1/0': buildingTile({1: rectangle(-64, 1000, 300, 1400)}),
        };
        const request = {building: new Set(['1'])};

        const fromLeft = await gatherRoofOutlines(tiles['14/0/0'], new CanonicalTileID(14, 0, 0), request, DEFAULT_TILE_BUFFER, undefined, loaderOf(tiles));
        const fromRight = await gatherRoofOutlines(tiles['14/1/0'], new CanonicalTileID(14, 1, 0), request, DEFAULT_TILE_BUFFER, undefined, loaderOf(tiles));

        expect(fromLeft).toEqual({building: {1: [new Point(7592, 2000), new Point(7592, 2800), new Point(8792, 2000), new Point(8792, 2800)]}});
        expect(fromRight.building[1]).toEqual(fromLeft.building[1].map((p) => new Point(p.x - EXTENT, p.y)));
    });

    test('gathers a building on a tile corner from the pieces in all four tiles', async () => {
        const tiles = {
            '14/0/0': buildingTile({1: rectangle(3900, 3900, 4160, 4160)}),
            '14/1/0': buildingTile({1: rectangle(-64, 3900, 200, 4160)}),
            '14/0/1': buildingTile({1: rectangle(3900, -64, 4160, 200)}),
            '14/1/1': buildingTile({1: rectangle(-64, -64, 200, 200)}),
        };

        const outlines = await gatherRoofOutlines(tiles['14/1/1'], new CanonicalTileID(14, 1, 1), {building: new Set(['1'])}, DEFAULT_TILE_BUFFER, undefined, loaderOf(tiles));

        expect(outlines).toEqual({building: {1: [new Point(-392, -392), new Point(-392, 400), new Point(400, -392), new Point(400, 400)]}});
    });

    test('gathers a building cut by the antimeridian from the tile across it', async () => {
        const tiles = {
            '14/0/0': buildingTile({1: rectangle(-64, 1000, 300, 1400)}),
            '14/16383/0': buildingTile({1: rectangle(3796, 1000, 4160, 1400)}),
        };

        const outlines = await gatherRoofOutlines(tiles['14/0/0'], new CanonicalTileID(14, 0, 0), {building: new Set(['1'])}, DEFAULT_TILE_BUFFER, undefined, loaderOf(tiles));

        expect(outlines).toEqual({building: {1: [new Point(-600, 2000), new Point(-600, 2800), new Point(600, 2000), new Point(600, 2800)]}});
    });

    test('gives no outline to a building reaching across more than two tiles', async () => {
        const tiles = {
            '14/0/0': buildingTile({1: rectangle(3900, 1000, 4160, 1400)}),
            '14/1/0': buildingTile({1: rectangle(-64, 1000, 4160, 1400)}),
            '14/2/0': buildingTile({1: rectangle(-64, 1000, 200, 1400)}),
        };

        const outlines = await gatherRoofOutlines(tiles['14/0/0'], new CanonicalTileID(14, 0, 0), {building: new Set(['1'])}, DEFAULT_TILE_BUFFER, undefined, loaderOf(tiles));

        expect(outlines).toEqual({});
    });

    test('gives no outline to a building whose piece in a neighbouring tile fails to load', async () => {
        const tile = buildingTile({1: rectangle(3796, 1000, 4160, 1400)});

        const outlines = await gatherRoofOutlines(tile, new CanonicalTileID(14, 0, 0), {building: new Set(['1'])}, DEFAULT_TILE_BUFFER, undefined,
            () => Promise.reject(new Error('offline')));

        expect(outlines).toEqual({});
    });
});

describe('outlinesInSlice', () => {
    test('scales outlines gathered at the maximum zoom into a tile sliced from it', () => {
        const outlines = {building: {1: [new Point(7592, 2000), new Point(8792, 2800)]}};

        expect(outlinesInSlice(outlines, new CanonicalTileID(14, 0, 0), new CanonicalTileID(15, 1, 0))).toEqual({
            building: {1: [new Point(7592 * 2 - EXTENT, 4000), new Point(8792 * 2 - EXTENT, 5600)]},
        });
    });
});

function rectangle(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

function buildingTile(buildings: Record<number, Array<[number, number]>>): VectorTileLike {
    const building = new GeoJSONWrapper(Object.entries(buildings).map(([id, ring]) => ({
        type: 3 as const,
        geometry: [ring],
        tags: {},
        id: Number(id),
    })), {version: 2, extent: 4096});
    building.name = 'building';
    return {layers: {building}};
}

function loaderOf(tiles: Record<string, VectorTileLike>): TileLoader {
    return ({z, x, y}) => Promise.resolve(tiles[`${z}/${x}/${y}`] ?? null);
}
