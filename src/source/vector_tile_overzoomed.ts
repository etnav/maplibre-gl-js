import Point from '@mapbox/point-geometry';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {clipGeometry} from '../symbol/clip_line.ts';
import {EXTENT} from '../data/extent.ts';
import {DEFAULT_TILE_BUFFER, isHeldWholeByEveryTile} from '../data/extent_bounds.ts';

import type {CanonicalTileID} from '../tile/tile_id.ts';
import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

function sliceBuffer(extent: number): number {
    return Math.max(128, Math.round(128 * extent / 4096));
}

export function slicedTileBuffer(extent: number): number {
    return Math.round(sliceBuffer(extent) * EXTENT / extent);
}

/** Max-zoom polygons in target tile coordinates, split into unclipped (`whole`) and border-clipped (`pieces`). */
export type SlicedPolygons = {
    whole: Point[][][];
    pieces: Point[][][];
};

class VectorTileFeatureOverzoomed implements VectorTileFeatureLike {
    pointsArray: Point[][];
    type: VectorTileFeatureLike['type'];
    properties: VectorTileFeatureLike['properties'];
    id: VectorTileFeatureLike['id'];
    extent: VectorTileFeatureLike['extent'];
    slicedPolygons?: SlicedPolygons;

    constructor(
        type: VectorTileFeatureLike['type'],
        geometry: Point[][],
        properties: VectorTileFeatureLike['properties'],
        id: VectorTileFeatureLike['id'],
        extent: VectorTileFeatureLike['extent'],
        slicedPolygons?: SlicedPolygons
    ) {
        this.type = type;
        this.properties = properties ? properties : {};
        this.extent = extent;
        this.pointsArray = geometry;
        this.id = id;
        this.slicedPolygons = slicedPolygons;
    }

    loadGeometry(): Point[][] {
        // Clone the geometry and ensure all points are Point instances
        return this.pointsArray.map(ring =>
            ring.map(point => new Point(point.x, point.y))
        );
    }
}

class VectorTileLayerOverzoomed implements VectorTileLayerLike {
    private _myFeatures: VectorTileFeatureOverzoomed[];
    name: string;
    extent: number;
    version: number = 2;
    length: number;

    constructor(features: VectorTileFeatureOverzoomed[], layerName: string, extent: number) {
        this._myFeatures = features;
        this.name = layerName;
        this.length = features.length;
        this.extent = extent;
    }

    feature(i: number): VectorTileFeatureLike {
        return this._myFeatures[i];
    }
}

export class VectorTileOverzoomed implements VectorTileLike {
    layers: Record<string, VectorTileLayerLike> = {};

    addLayer(layer: VectorTileLayerOverzoomed): void {
        this.layers[layer.name] = layer;
    }
}

export function getSlicedPolygons(feature: VectorTileFeatureLike): SlicedPolygons | undefined {
    return feature instanceof VectorTileFeatureOverzoomed ? feature.slicedPolygons : undefined;
}

/**
 * This function slices a source tile layer into an overzoomed tile layer for a target tile ID.
 * The geometry is clipped to the target tile plus a buffer of at least 128 units, which is 16 pixels on a 512 pixel tile with the default extent of 4096.
 * The buffer grows with the extent, so that tiles with a larger extent keep this size on screen, otherwise the edges created by the clipping show up in line layers.
 * @param sourceLayer - the source tile layer to slice
 * @param maxZoomTileID - the maximum zoom tile ID
 * @param targetTileID - the target tile ID
 * @param keepPolygons - when true, retain max-zoom polygon classification so overzoomed tiles build matching roofs across borders
 * @returns - the overzoomed tile layer
 */
export function sliceVectorTileLayer(
    sourceLayer: VectorTileLayerLike,
    maxZoomTileID: CanonicalTileID,
    targetTileID: CanonicalTileID,
    keepPolygons = false
): VectorTileLayerOverzoomed {
    const {extent} = sourceLayer;
    const dz = targetTileID.z - maxZoomTileID.z;
    const scale = Math.pow(2, dz);

    // Calculate the target tile's position within the source tile in target coordinate space
    // This ensures all tiles share the same coordinate system
    const offsetX = (targetTileID.x - maxZoomTileID.x * scale) * extent;
    const offsetY = (targetTileID.y - maxZoomTileID.y * scale) * extent;
    const buffer = sliceBuffer(extent);

    // Transform all coordinates to target tile space
    function toTarget(rings: Point[][]): void {
        for (const ring of rings) {
            for (const point of ring) {
                point.x = point.x * scale - offsetX;
                point.y = point.y * scale - offsetY;
            }
        }
    }

    const featureWrappers: VectorTileFeatureOverzoomed[] = [];
    for (let index = 0; index < sourceLayer.length; index++) {
        const feature: VectorTileFeatureLike = sourceLayer.feature(index);
        const raw = feature.loadGeometry();
        let geometry: Point[][];
        let polygons: SlicedPolygons | undefined;

        if (keepPolygons && feature.type === 3) {
            const sourceBuffer = DEFAULT_TILE_BUFFER * extent / EXTENT;
            const classified = classifyRings(raw);
            const isWhole = classified.map((poly) => isHeldWholeByEveryTile(poly[0], sourceBuffer, extent));
            toTarget(raw);
            geometry = clipGeometry(raw, 3, -buffer, -buffer, extent + buffer, extent + buffer);
            if (geometry.length === 0) continue;

            polygons = {whole: [], pieces: []};
            for (let i = 0; i < classified.length; i++) {
                const clipped = clipGeometry(classified[i], 3, -buffer, -buffer, extent + buffer, extent + buffer);
                if (clipped.length === 0) continue;
                if (isWhole[i]) polygons.whole.push(classified[i]);
                else polygons.pieces.push(clipped);
            }
        } else {
            toTarget(raw);
            geometry = clipGeometry(raw, feature.type, -buffer, -buffer, extent + buffer, extent + buffer);
            if (geometry.length === 0) continue;
        }

        featureWrappers.push(new VectorTileFeatureOverzoomed(
            feature.type,
            geometry,
            feature.properties,
            feature.id,
            extent,
            polygons
        ));
    }
    return new VectorTileLayerOverzoomed(featureWrappers, sourceLayer.name, extent);
}
