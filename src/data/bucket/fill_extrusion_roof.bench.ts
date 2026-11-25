import {test} from 'vitest';
import {FillExtrusionBucket} from './fill_extrusion_bucket.ts';
import {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer.ts';
import {createGeoJSONIndex} from '../../source/geojson_worker_source.ts';
import {GeoJSONWrapper} from '@maplibre/vt-pbf';
import {EXTENT} from '../extent.ts';
import {CanonicalTileID} from '../../tile/tile_id.ts';
import {createPopulateOptions, getFeaturesFromLayer} from '../../../test/unit/lib/tile.ts';

import type {FillExtrusionLayerSpecification, LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import type {ZoomHistory} from '../../style/zoom_history.ts';
import type {BucketParameters} from '../bucket.ts';
import type {RoofShape} from './roof/roof_shapes.ts';

const SHAPES: RoofShape[] = [
    'flat', 'skillion', 'gabled', 'hipped', 'half_hipped', 'pyramidal',
    'mansard', 'gambrel', 'saltbox', 'round', 'dome',
];

function buildFixtureGeoJSON(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    const baseLon = 10.998;
    const baseLat = 48.999;
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < SHAPES.length; col++) {
            const x0 = baseLon + col * 0.00045;
            const y0 = baseLat + row * 0.00035;
            const w = 0.00028;
            const h = 0.00018;
            const coords: GeoJSON.Position[][] = row === 3 ? [[
                [x0, y0], [x0 + w, y0], [x0 + w, y0 + h * 0.5],
                [x0 + w * 0.45, y0 + h * 0.5], [x0 + w * 0.45, y0 + h],
                [x0, y0 + h], [x0, y0],
            ]] : [[
                [x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0],
            ]];
            features.push({
                type: 'Feature',
                id: row * SHAPES.length + col + 1,
                properties: {
                    height: 14 + (row * 2),
                    roof_shape: SHAPES[col],
                    roof_height: 4,
                    roof_direction: (row * 45) % 360,
                },
                geometry: {type: 'Polygon', coordinates: coords},
            });
        }
    }
    return {type: 'FeatureCollection', features};
}

const tileZ = 14;
const geojson = buildFixtureGeoJSON();

function lonLatToTileXY(lon: number, lat: number, z: number): {x: number; y: number} {
    const n = 2 ** z;
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return {x, y};
}

const {x: tileX, y: tileY} = lonLatToTileXY(11.0, 48.9995, tileZ);
const geoJsonIndex = createGeoJSONIndex(geojson, {type: 'geojson', source: 'buildings', geojsonVtOptions: {maxZoom: tileZ, buffer: 512}}, false);
const geoJsonTile = geoJsonIndex.getTile(tileZ, tileX, tileY);
if (!geoJsonTile) throw new Error('Fixture tile missing');

const sourceLayer = new GeoJSONWrapper(geoJsonTile.features, {version: 2, extent: EXTENT});

function createBucket(layout: LayerSpecification['layout'], paint: LayerSpecification['paint']): FillExtrusionBucket {
    const layer = new FillExtrusionStyleLayer({
        id: 'building',
        type: 'fill-extrusion',
        layout,
        paint,
    } as LayerSpecification, {});
    layer.recalculate({zoom: tileZ, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return new FillExtrusionBucket({layers: [layer]} as BucketParameters<FillExtrusionStyleLayer>);
}

const indexedFeatures = getFeaturesFromLayer(sourceLayer);
const canonical = new CanonicalTileID(tileZ, tileX, tileY);
const populateOptions = createPopulateOptions([]);

const flatPaint: FillExtrusionLayerSpecification['paint'] = {
    'fill-extrusion-height': ['get', 'height'],
    'fill-extrusion-roof-height': 0,
};
const flatLayout: FillExtrusionLayerSpecification['layout'] = {
    'fill-extrusion-roof-shape': 'flat',
};

const pitchedPaint: FillExtrusionLayerSpecification['paint'] = {
    'fill-extrusion-height': ['get', 'height'],
    'fill-extrusion-roof-height': ['get', 'roof_height'],
};
const pitchedLayout: FillExtrusionLayerSpecification['layout'] = {
    'fill-extrusion-roof-shape': ['get', 'roof_shape'],
    'fill-extrusion-roof-direction': ['get', 'roof_direction'],
};

function populateFlat(): void {
    const bucket = createBucket(flatLayout, flatPaint);
    bucket.populate(indexedFeatures, populateOptions, canonical);
}

function populatePitched(): void {
    const bucket = createBucket(pitchedLayout, pitchedPaint);
    bucket.populate(indexedFeatures, populateOptions, canonical);
}

populateFlat();
populatePitched();

test('FillExtrusionBucket roof layout', async ({bench}) => {
    await bench.compare(
        bench('flat roofs', () => {
            populateFlat();
        }),
        bench('pitched roof shapes (fixture properties)', () => {
            populatePitched();
        }),
    );
});
