import {beforeAll, describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {VectorTile} from '@mapbox/vector-tile';
import {encodeTile} from '@maplibre/mlt';
import {fromVectorTileJs, GeoJSONWrapper} from '@maplibre/vt-pbf';
import {PbfReader} from 'pbf';
import {EXTENT} from '../extent.ts';
import {DEFAULT_TILE_BUFFER} from '../extent_bounds.ts';
import {FillExtrusionBucket} from './fill_extrusion_bucket.ts';
import {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer.ts';
import {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import {CanonicalTileID} from '../../tile/tile_id.ts';
import {MLTVectorTile} from '../../source/vector_tile_mlt.ts';
import {sliceVectorTileLayer, slicedTileBuffer} from '../../source/vector_tile_overzoomed.ts';
import {type CreateBucketParameters, createPopulateOptions, getFeaturesFromLayer, loadVectorTile} from '../../../test/unit/lib/tile.ts';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import type {ZoomHistory} from '../../style/zoom_history.ts';
import type {BucketParameters, IndexedFeature} from '../bucket.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

function createFillExtrusionBucket({id, layout, paint, globalState, availableImages}: CreateBucketParameters, tileBuffer?: number): FillExtrusionBucket {
    const layer = new FillExtrusionStyleLayer({
        id,
        type: 'fill-extrusion',
        'source-layer': 'building',
        layout,
        paint
    } as LayerSpecification, globalState);
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters,
        availableImages);

    return new FillExtrusionBucket({layers: [layer], tileBuffer} as BucketParameters<FillExtrusionStyleLayer>);
}

function closedRect(x0: number, y0: number, x1: number, y1: number): Point[][] {
    return [[
        new Point(x0, y0),
        new Point(x1, y0),
        new Point(x1, y1),
        new Point(x0, y1),
        new Point(x0, y0),
    ]];
}

function wallVertexCount(bucket: FillExtrusionBucket): number {
    const layout = bucket.layoutVertexArray.int16;
    let count = 0;
    for (let i = 0; i < bucket.layoutVertexArray.length; i++) {
        if (layout[i * 6 + 4] === 0) count++;
    }
    return count;
}

function polygonFeature(geometry: Point[][], properties: Record<string, unknown> = {}, id = 1): IndexedFeature {
    return {
        feature: {
            type: 3,
            extent: EXTENT,
            id,
            properties,
            loadGeometry: () => geometry.map((ring) => ring.map((p) => new Point(p.x, p.y))),
        },
        id,
        index: 0,
        sourceLayerIndex: 0,
    } as unknown as IndexedFeature;
}

function gabledRoofLayout(overrides: Record<string, unknown> = {}) {
    return {
        'fill-extrusion-roof-shape': 'gabled',
        'fill-extrusion-roof-direction': 0,
        ...overrides,
    };
}

const HEIGHT_FROM_PAINT = -1;

/** Sorted `[x, y, fraction, storedHeight]` tuples for roof-cap vertices (`nz > 0`). */
function pitchedCapVertices(bucket: FillExtrusionBucket): string[] {
    const layout = bucket.layoutVertexArray;
    const roof = bucket.roofVertexArray;
    const rows: string[] = [];
    for (let i = 0; i < layout.length; i++) {
        const o = i * 6;
        if (layout.int16[o + 4] <= 0) continue;
        const fraction = roof.int16[i * 2];
        if (fraction < 0) continue;
        rows.push([layout.int16[o], layout.int16[o + 1], fraction, roof.int16[i * 2 + 1]].join(','));
    }
    return rows.sort();
}

function roofHeightsStored(bucket: FillExtrusionBucket): number[] {
    const heights = new Set<number>();
    for (let i = 0; i < bucket.roofVertexArray.length; i++) {
        if (bucket.roofVertexArray.int16[i * 2] >= 0) heights.add(bucket.roofVertexArray.int16[i * 2 + 1]);
    }
    return [...heights];
}

describe('FillExtrusionBucket', () => {
    let sourceLayer: VectorTileLayerLike;
    beforeAll(() => {
        // Load fill extrusion features from fixture tile.
        sourceLayer = loadVectorTile().layers.water;
    });

    test('FillExtrusionBucket fill-pattern with global-state', () => {
        const availableImages = [];
        const bucket = createFillExtrusionBucket({id: 'test',
            paint: {'fill-extrusion-pattern': ['coalesce', ['get', 'pattern'], ['global-state', 'pattern']]},
            globalState: {pattern: 'test-pattern'},
            availableImages
        });

        bucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions(availableImages), undefined);

        expect(bucket.features.length).toBeGreaterThan(0);
        expect(bucket.features[0].patterns).toEqual({
            test: {min: 'test-pattern', mid: 'test-pattern', max: 'test-pattern'}
        });
    });

    test('FillExtrusionBucket populates vertices with fill-extrusion-rounded-corner-distance layout property', () => {
        const bucketWithoutRounding = createFillExtrusionBucket({
            id: 'test-no-rounding',
            layout: {'fill-extrusion-rounded-corner-distance': 0},
            paint: {'fill-extrusion-height': 10}
        });
        const bucketWithRounding = createFillExtrusionBucket({
            id: 'test-rounding',
            layout: {'fill-extrusion-rounded-corner-distance': 5},
            paint: {'fill-extrusion-height': 10}
        });

        const features = getFeaturesFromLayer(sourceLayer);
        const populateOptions = createPopulateOptions([]);

        bucketWithoutRounding.populate(features, populateOptions, {x: 0, y: 0, z: 14} as any);
        bucketWithRounding.populate(features, populateOptions, {x: 0, y: 0, z: 14} as any);

        expect(bucketWithoutRounding.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucketWithRounding.layoutVertexArray.length).toBeGreaterThan(bucketWithoutRounding.layoutVertexArray.length);
    });

    test('FillExtrusionBucket pitched roof keeps segment-local indices and paired roof attributes', () => {
        const bucket = createFillExtrusionBucket({
            id: 'gabled-roof',
            layout: {
                'fill-extrusion-roof-shape': 'gabled',
                'fill-extrusion-roof-direction': 0,
            },
            paint: {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5},
        });

        const canonical = new CanonicalTileID(14, 0, 0);
        const footprint = [[
            new Point(1000, 1000),
            new Point(3000, 1000),
            new Point(3000, 3000),
            new Point(1000, 3000),
            new Point(1000, 1000),
        ]];

        bucket.addFeature(
            {
                id: 1,
                index: 0,
                sourceLayerIndex: 0,
                geometry: footprint,
                properties: {},
                type: 3,
                patterns: {},
            },
            footprint,
            0,
            canonical,
            {},
            SubdivisionGranularitySetting.noSubdivision,
            {
                shape: 'gabled',
                direction: 0,
                roofHeight: 5,
            },
        );

        expect(bucket.usesRoofAttributes).toBe(true);
        expect(bucket.roofVertexArray).toHaveLength(bucket.layoutVertexArray.length);
        expect(bucket.segments.get().length).toBeGreaterThan(0);

        for (const segment of bucket.segments.get()) {
            for (let tri = 0; tri < segment.primitiveLength; tri++) {
                const base = (segment.primitiveOffset + tri) * 3;
                for (let corner = 0; corner < 3; corner++) {
                    const vertexIndex = bucket.indexArray.uint16[base + corner];
                    expect(vertexIndex).toBeGreaterThanOrEqual(0);
                    expect(vertexIndex).toBeLessThan(segment.vertexLength);
                }
            }
        }
    });

    test('roof cap with more vertices than one segment can index is split across segments', () => {
        const bucket = createFillExtrusionBucket({id: 'gabled-roof', layout: gabledRoofLayout(), paint: {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 0}});
        const zigzag: Point[] = [];
        for (let i = 0; i < 70000; i++) zigzag.push(new Point(100 + i * 0.1, 1000 + (i % 2) * 40));
        const ring = [...zigzag, new Point(7100, 3000), new Point(100, 3000), zigzag[0]];
        bucket.addFeature(
            {id: 1, index: 0, sourceLayerIndex: 0, geometry: [ring], properties: {}, type: 3, patterns: {}},
            [ring], 0, new CanonicalTileID(14, 0, 0), {}, SubdivisionGranularitySetting.noSubdivision,
            {shape: 'gabled', direction: 0, roofHeight: 0},
        );

        const layout = bucket.layoutVertexArray.int16;
        let capArea = 0;
        for (const segment of bucket.segments.get()) {
            expect(segment.vertexLength).toBeLessThanOrEqual(65535);
            for (let tri = 0; tri < segment.primitiveLength; tri++) {
                const base = (segment.primitiveOffset + tri) * 3;
                const corners = [0, 1, 2].map((corner) => (segment.vertexOffset + bucket.indexArray.uint16[base + corner]) * 6);
                if (corners.some((o) => layout[o + 4] <= 0)) continue;
                const [ax, ay, bx, by, cx, cy] = corners.flatMap((o) => [layout[o], layout[o + 1]]);
                capArea += ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
            }
        }

        let ringArea = 0;
        for (let i = 1; i < ring.length; i++) {
            const [a, b] = [ring[i - 1], ring[i]].map((p) => new Point(Math.round(p.x), Math.round(p.y)));
            ringArea += (a.x * b.y - b.x * a.y) / 2;
        }
        expect(Math.abs(capArea)).toBe(Math.abs(ringArea));
    });

    test('pitched roof takes a styled height from the paint property, and stores the pitch-derived one in centimetres', () => {
        const footprint = [[new Point(1000, 1000), new Point(3000, 1000), new Point(3000, 3000), new Point(1000, 3000), new Point(1000, 1000)]];
        const styled = createFillExtrusionBucket({id: 'styled', layout: {'fill-extrusion-roof-shape': 'skillion'}, paint: {'fill-extrusion-height': 30}});
        const derived = createFillExtrusionBucket({id: 'derived', layout: {'fill-extrusion-roof-shape': 'skillion'}, paint: {'fill-extrusion-height': 30}});

        for (const [bucket, roofHeight] of [[styled, 2.83], [derived, undefined]] as const) {
            bucket.addFeature(
                {id: 1, index: 0, sourceLayerIndex: 0, geometry: footprint, properties: {}, type: 3, patterns: {}},
                footprint, 0, new CanonicalTileID(14, 0, 0), {}, SubdivisionGranularitySetting.noSubdivision,
                {shape: 'skillion', direction: 0, roofHeight},
            );
        }

        expect(roofHeightsStored(styled)).toEqual([HEIGHT_FROM_PAINT]);
        const [derivedHeight, ...others] = roofHeightsStored(derived);
        expect(others).toEqual([]);
        expect(derivedHeight).toBeGreaterThan(0);
        expect(Number.isInteger(derivedHeight)).toBe(true);
    });

    test('pitched roof spanning a tile border matches in both neighbours within the buffer margin', () => {
        const layout = gabledRoofLayout();
        const paint = {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5};
        const right = createFillExtrusionBucket({id: 'right', layout, paint});
        const left = createFillExtrusionBucket({id: 'left', layout, paint});

        const rightFootprint = closedRect(-50, 1000, 50, 1400);
        const leftFootprint = closedRect(EXTENT - 50, 1000, EXTENT + 50, 1400);

        right.populate([polygonFeature(rightFootprint)], createPopulateOptions([]), new CanonicalTileID(14, 1, 0));
        left.populate([polygonFeature(leftFootprint)], createPopulateOptions([]), new CanonicalTileID(14, 0, 0));

        expect(right.usesRoofAttributes).toBe(true);
        expect(left.usesRoofAttributes).toBe(true);

        const rightCaps = pitchedCapVertices(right);
        const leftCaps = pitchedCapVertices(left).map((row) => {
            const [x, y, f, h] = row.split(',').map(Number);
            return [x - EXTENT, y, f, h].join(',');
        });
        expect(leftCaps).toEqual(rightCaps);
    });

    test('pitched roof reaching past the buffer margin gets the same flat cap halfway up the roof in both neighbours', () => {
        const layout = gabledRoofLayout();
        const paint = {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5};
        const right = createFillExtrusionBucket({id: 'right', layout, paint});
        const left = createFillExtrusionBucket({id: 'left', layout, paint});

        right.populate([polygonFeature(closedRect(-50, 1000, 300, 1400))], createPopulateOptions([]), new CanonicalTileID(14, 1, 0));
        left.populate([polygonFeature(closedRect(EXTENT - 50, 1000, EXTENT + DEFAULT_TILE_BUFFER, 1400))], createPopulateOptions([]), new CanonicalTileID(14, 0, 0));

        const halfwayUpThePaintedHeight = `16384,${HEIGHT_FROM_PAINT}`;
        for (const bucket of [right, left]) {
            const capLevels = pitchedCapVertices(bucket).map((row) => row.split(',').slice(2).join(','));
            expect(capLevels.length).toBeGreaterThan(0);
            expect(new Set(capLevels)).toEqual(new Set([halfwayUpThePaintedHeight]));
        }
    });

    test('pitched roofs over the pieces of a building cut by a tile border follow its whole outline in both neighbours', () => {
        const layout = gabledRoofLayout({'fill-extrusion-roof-shape': 'hipped'});
        const paint = {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5};
        const right = createFillExtrusionBucket({id: 'right', layout, paint});
        const left = createFillExtrusionBucket({id: 'left', layout, paint});
        const outline = [new Point(-300, 1000), new Point(-300, 1400), new Point(300, 1000), new Point(300, 1400)];

        right.populate(
            [polygonFeature(closedRect(-DEFAULT_TILE_BUFFER, 1000, 300, 1400))],
            {...createPopulateOptions([]), roofOutlines: {building: {1: outline}}},
            new CanonicalTileID(14, 1, 0));
        left.populate(
            [polygonFeature(closedRect(EXTENT - 300, 1000, EXTENT + DEFAULT_TILE_BUFFER, 1400))],
            {...createPopulateOptions([]), roofOutlines: {building: {1: outline.map((p) => new Point(p.x + EXTENT, p.y))}}},
            new CanonicalTileID(14, 0, 0));

        for (const [bucket, border] of [[right, 0], [left, EXTENT]] as const) {
            const caps = pitchedCapVertices(bucket).map((row) => row.split(',').map(Number));
            expect(caps.some(([, , fraction]) => fraction === 32767)).toBe(true);
            for (const [x, y, fraction] of caps) {
                expect(fraction / 32767).toBeCloseTo(Math.min(200 - Math.abs(y - 1200), 300 - Math.abs(x - border)) / 200, 3);
            }
        }
    });

    test('dome over a piece of a building keeps the flat cap halfway up the roof despite its outline', () => {
        const bucket = createFillExtrusionBucket({id: 'dome', layout: gabledRoofLayout({'fill-extrusion-roof-shape': 'dome'}), paint: {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5}});
        const outline = [new Point(EXTENT - 300, 1000), new Point(EXTENT - 300, 1400), new Point(EXTENT + 300, 1000), new Point(EXTENT + 300, 1400)];

        bucket.populate(
            [polygonFeature(closedRect(EXTENT - 300, 1000, EXTENT + DEFAULT_TILE_BUFFER, 1400))],
            {...createPopulateOptions([]), roofOutlines: {building: {1: outline}}},
            new CanonicalTileID(14, 0, 0));

        const capLevels = pitchedCapVertices(bucket).map((row) => row.split(',').slice(2).join(','));
        expect(capLevels.length).toBeGreaterThan(0);
        expect(new Set(capLevels)).toEqual(new Set([`16384,${HEIGHT_FROM_PAINT}`]));
    });

    test('pitched roof reaching past the default margin stays pitched in both neighbours when the source states a wider buffer', () => {
        const layout = gabledRoofLayout();
        const paint = {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5};
        const right = createFillExtrusionBucket({id: 'right', layout, paint}, 512);
        const left = createFillExtrusionBucket({id: 'left', layout, paint}, 512);

        right.populate([polygonFeature(closedRect(-50, 1000, 300, 1400))], createPopulateOptions([]), new CanonicalTileID(14, 1, 0));
        left.populate([polygonFeature(closedRect(EXTENT - 50, 1000, EXTENT + 300, 1400))], createPopulateOptions([]), new CanonicalTileID(14, 0, 0));

        const rightCaps = pitchedCapVertices(right);
        const leftCaps = pitchedCapVertices(left).map((row) => {
            const [x, y, f, h] = row.split(',').map(Number);
            return [x - EXTENT, y, f, h].join(',');
        });
        expect(rightCaps.some((row) => row.split(',')[2] === '32767')).toBe(true);
        expect(leftCaps).toEqual(rightCaps);
    });

    test('pitched roof over a whole footprint reaching tiles past the border of a sliced tile stays pitched, clipped to the tile buffer', () => {
        const z14 = new GeoJSONWrapper([{
            type: 3,
            geometry: [[[900, 600], [2100, 600], [2100, 700], [900, 700], [900, 600]]],
            tags: {},
            id: 1,
        }], {version: 2, extent: 4096});
        const z18 = new CanonicalTileID(18, 3, 2);
        const sliced = sliceVectorTileLayer(z14, new CanonicalTileID(14, 0, 0), z18, true);
        const tileBuffer = slicedTileBuffer(sliced.extent);
        const bucket = createFillExtrusionBucket({id: 'sliced', layout: gabledRoofLayout(), paint: {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5}}, tileBuffer);

        bucket.populate(getFeaturesFromLayer(sliced), createPopulateOptions([]), z18);

        const layout = bucket.layoutVertexArray.int16;
        const roof = bucket.roofVertexArray.int16;
        const capFractions: number[] = [];
        for (let i = 0; i < bucket.layoutVertexArray.length; i++) {
            const [x, y] = [layout[i * 6], layout[i * 6 + 1]];
            expect(x).toBeGreaterThanOrEqual(-tileBuffer);
            expect(x).toBeLessThanOrEqual(EXTENT + tileBuffer);
            if (layout[i * 6 + 4] <= 0) continue;

            const fraction = roof[i * 2] / 32767;
            expect(fraction).toBeCloseTo(1 - Math.abs(y - 4416) / 1600, 2);
            capFractions.push(fraction);
        }
        expect(capFractions).toContain(1);
    });

    test('pitched roof without a roof height falls back to flat when an edge lies on the tile border', () => {
        const bucket = createFillExtrusionBucket({
            id: 'clip-edge',
            layout: {
                'fill-extrusion-roof-shape': 'gabled',
                'fill-extrusion-roof-direction': 0,
            },
            paint: {'fill-extrusion-height': 20},
        });
        bucket.populate([polygonFeature(closedRect(0, 1000, 100, 1400))], createPopulateOptions([]), new CanonicalTileID(14, 0, 0));

        expect(bucket.usesRoofAttributes).toBe(false);
    });

    test('whole footprint with a courtyard hole inside the tile buffer keeps the courtyard walls', () => {
        const outer = closedRect(EXTENT - 40, 1000, EXTENT + 80, 1400)[0];
        const hole = [...closedRect(EXTENT + 10, 1100, EXTENT + 50, 1300)[0]].reverse();
        const withoutHole = createFillExtrusionBucket({id: 'no-hole', layout: gabledRoofLayout(), paint: {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5}});
        const withHole = createFillExtrusionBucket({id: 'with-hole', layout: gabledRoofLayout(), paint: {'fill-extrusion-height': 20, 'fill-extrusion-roof-height': 5}});

        withoutHole.populate([polygonFeature([outer])], createPopulateOptions([]), new CanonicalTileID(14, 0, 0));
        withHole.populate([polygonFeature([outer, hole])], createPopulateOptions([]), new CanonicalTileID(14, 0, 0));

        expect(wallVertexCount(withHole)).toBeGreaterThan(wallVertexCount(withoutHole));
    });

    test.each(['mvt', 'mlt'] as const)('data-driven roofs from %s tiles enable roof attributes', (encoding) => {
        const tileExtent = 4096;
        const ring = [
            {x: 500, y: 500},
            {x: 1500, y: 500},
            {x: 1500, y: 1250},
            {x: 500, y: 1250},
            {x: 500, y: 500},
        ];
        const properties = {
            height: 20,
            roof_shape: 'gabled',
            roof_height: 5,
            roof_direction: 90,
        };

        let layer: VectorTileLayerLike;
        if (encoding === 'mvt') {
            const wrapper = new GeoJSONWrapper([{
                type: 3,
                geometry: [ring.map((p) => [p.x, p.y] as [number, number])],
                tags: properties,
                id: 1,
            }], {version: 2, extent: tileExtent});
            wrapper.name = 'building';
            const pbf = fromVectorTileJs({layers: {building: wrapper}});
            layer = new VectorTile(new PbfReader(pbf)).layers.building;
        } else {
            const mlt = encodeTile([{
                name: 'building',
                extent: tileExtent,
                features: [{
                    id: 1,
                    geometry: {
                        type: 'Polygon',
                        coordinates: [ring.slice(0, -1).map((p) => [p.x, p.y] as [number, number])],
                    },
                    properties,
                }],
            }], {
                propertyTypes: {
                    height: 'float',
                    roof_height: 'float',
                    roof_direction: 'float',
                    roof_shape: 'string',
                },
            });
            layer = new MLTVectorTile(mlt.buffer as ArrayBuffer).layers.building;
        }

        const bucket = createFillExtrusionBucket({
            id: `driven-${encoding}`,
            layout: {
                'fill-extrusion-roof-shape': ['get', 'roof_shape'],
                'fill-extrusion-roof-direction': ['to-number', ['get', 'roof_direction']],
            },
            paint: {
                'fill-extrusion-height': ['get', 'height'],
                'fill-extrusion-roof-height': ['to-number', ['get', 'roof_height']],
            },
        });
        bucket.populate(getFeaturesFromLayer(layer), createPopulateOptions([]), new CanonicalTileID(14, 0, 0));

        expect(bucket.usesRoofAttributes).toBe(true);
        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucket.roofVertexArray).toHaveLength(bucket.layoutVertexArray.length);
    });
});
