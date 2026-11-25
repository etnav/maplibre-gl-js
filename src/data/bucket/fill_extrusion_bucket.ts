import {FillExtrusionLayoutArray, PosArray} from '../array_types.g.ts';
import {members as layoutAttributes, centroidAttributes, roofAttributes} from './fill_extrusion_attributes.ts';
import {type Segment, SegmentVector} from '../segment.ts';
import {ProgramConfigurationSet} from '../program_configuration.ts';
import {TriangleIndexArray} from '../index_array_type.ts';
import {EXTENT} from '../extent.ts';
import {DEFAULT_TILE_BUFFER, isBoundaryEdge, isEntirelyOutside, isHeldWholeByEveryTile} from '../extent_bounds.ts';
import {VectorTileFeature} from '@mapbox/vector-tile';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
const EARCUT_MAX_RINGS = 500;
import Point from '@mapbox/point-geometry';
import {register} from '../../util/web_worker_transfer.ts';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features.ts';
import {loadGeometry, scaleToExtent} from '../load_geometry.ts';
import {toEvaluationFeature} from '../evaluation_feature.ts';
import {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import {subdividePolygon, subdivideVertexLine} from '../../render/subdivision.ts';
import {fillLargeMeshArrays} from '../../render/fill_large_mesh_arrays.ts';
import {getTileUnitsForMeters, getTileUnitsForMetersAt, roundPolygonCornersIfNeeded, roundedWallNormals} from './round_polygon_corners.ts';
import {buildOutlineFrame} from './roof/roof_frame.ts';
import {buildRoof, clipRoofMesh, type RoofGeometry} from './roof/build_roof.ts';
import {evaluateRoofStyle, type RoofInput, type RoofMesh, type RoofStyle, type WallStop} from './roof/roof_shapes.ts';
import {getSlicedPolygons, type SlicedPolygons} from '../../source/vector_tile_overzoomed.ts';

import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    BucketDependencyParameters,
    IndexedFeature,
    PopulateParameters
} from '../bucket.ts';
import type {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer.ts';
import type {Context} from '../../webgl/context.ts';
import type {IndexBuffer} from '../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../source/source_state.ts';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

const FACTOR = Math.pow(2, 13);
const ROOF_FRACTION_SCALE = 32767;
const ROOF_HEIGHT_CM_MAX = 32767;
const ROOF_HEIGHT_FROM_PAINT = -1;
const INT16_MIN = -32768;
const INT16_MAX = 32767;
const FLAT_ROOF_STYLE: RoofStyle = {shape: 'flat'};

function addVertex(vertexArray, x, y, nx, ny, nz, t, e) {
    vertexArray.emplaceBack(
        // a_pos
        x,
        y,
        // a_normal_ed: 3-component normal and 1-component edgedistance
        Math.floor(nx * FACTOR) * 2 + t,
        ny * FACTOR * 2,
        nz * FACTOR * 2,
        // edgedistance (used for wrapping patterns around extrusion sides)
        Math.round(e)
    );
}

type CentroidAccumulator = {
    x: number;
    y: number;
    sampleCount: number;
};

/** Packed `a_roof.y`: `-1` when height comes from `fill-extrusion-roof-height`, otherwise pitch-derived height in cm. */
function storedRoofHeight(geometry: RoofGeometry | null, styledRoofHeight: number | undefined): number {
    if (!geometry || geometry.roofHeight <= 0) return 0;
    if (styledRoofHeight !== undefined) return ROOF_HEIGHT_FROM_PAINT;
    return Math.min(ROOF_HEIGHT_CM_MAX, Math.round(geometry.roofHeight * 100));
}

function encodeRoofFraction(fraction: number): number {
    if (fraction < 0) return -1;
    return Math.round(Math.max(0, Math.min(1, fraction)) * ROOF_FRACTION_SCALE);
}

function footprintCenter(polygon: Point[][]): [number, number] {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const ring of polygon) {
        for (let i = 0; i < ring.length; i++) {
            const p = ring[i];
            if (i === ring.length - 1 && ring[0].x === p.x && ring[0].y === p.y) continue;
            sx += p.x;
            sy += p.y;
            n++;
        }
    }
    return n === 0 ? [EXTENT / 2, EXTENT / 2] : [sx / n, sy / n];
}

function metersPerTileUnitAt([x, y]: [number, number], canonical: CanonicalTileID): number {
    return 1 / getTileUnitsForMetersAt(1, x, y, canonical);
}

function clampInt16(value: number): number {
    return Math.max(INT16_MIN, Math.min(INT16_MAX, value));
}

type ExtrudedPolygon = {footprint: Point[][]; whole: boolean};

type FillExtrusionFeature = BucketFeature & {
    roofStyle?: RoofStyle;
    roofPolygons?: ExtrudedPolygon[];
    roofOutline?: Point[];
};

function extrudedPolygons(geometry: Point[][], isWhole: (outer: Point[]) => boolean): ExtrudedPolygon[] {
    return classifyRings(geometry, EARCUT_MAX_RINGS).map((footprint) => ({footprint, whole: isWhole(footprint[0] ?? [])}));
}

function slicedRoofPolygons(sliced: SlicedPolygons, extent: number): ExtrudedPolygon[] {
    return [
        ...sliced.whole.map((polygon) => ({footprint: scaleToExtent(polygon, extent), whole: true})),
        ...sliced.pieces.flatMap((polygon) => extrudedPolygons(scaleToExtent(polygon, extent), () => false)),
    ];
}

/** Clips segment `(a, b)` to `[min, max]` on both axes, returning `null` when outside or degenerate. */
function clipSegmentToSquare(a: Point, b: Point, min: number, max: number): [Point, Point] | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;

    if (dx === 0) {
        if (a.x < min || a.x > max) return null;
    } else {
        const tx0 = (min - a.x) / dx;
        const tx1 = (max - a.x) / dx;
        t0 = Math.max(t0, Math.min(tx0, tx1));
        t1 = Math.min(t1, Math.max(tx0, tx1));
    }

    if (dy === 0) {
        if (a.y < min || a.y > max) return null;
    } else {
        const ty0 = (min - a.y) / dy;
        const ty1 = (max - a.y) / dy;
        t0 = Math.max(t0, Math.min(ty0, ty1));
        t1 = Math.min(t1, Math.max(ty0, ty1));
    }

    if (t1 - t0 < 1e-9) return null;
    return [
        t0 === 0 ? a : new Point(a.x + dx * t0, a.y + dy * t0),
        t1 === 1 ? b : new Point(a.x + dx * t1, a.y + dy * t1),
    ];
}

export class FillExtrusionBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    tileBuffer: number;
    layers: FillExtrusionStyleLayer[];
    layerIds: string[];
    stateDependentLayers: FillExtrusionStyleLayer[];
    stateDependentLayerIds: string[];

    layoutVertexArray: FillExtrusionLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    centroidVertexArray: PosArray;
    centroidVertexBuffer: VertexBuffer;

    roofVertexArray: PosArray | null;
    roofVertexBuffer: VertexBuffer | null;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    hasDependencies: boolean;
    programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;
    features: FillExtrusionFeature[];
    usesRoofAttributes: boolean;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.tileBuffer = options.tileBuffer ?? DEFAULT_TILE_BUFFER;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasDependencies = false;

        this.layoutVertexArray = new FillExtrusionLayoutArray();
        this.centroidVertexArray = new PosArray();
        this.roofVertexArray = null;
        this.roofVertexBuffer = null;
        this.usesRoofAttributes = false;
        this.indexArray = new TriangleIndexArray();
        const layer = options.layers[0];
        const mayDrawRoofs = layer.mayDrawPitchedRoofs();
        const hasRoofColor = layer.hasRoofColor();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom, (property) => {
            if (property === 'fill-extrusion-roof-color') return hasRoofColor;
            if (property === 'fill-extrusion-roof-height') return mayDrawRoofs;
            return true;
        });
        this.segments = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
    }

    populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
        this.features = [];
        this.hasDependencies = hasPattern('fill-extrusion', this.layers, options);

        const globalProperties = new EvaluationParameters(this.zoom);
        const layer = this.layers[0];
        const mayDrawRoofs = layer.mayDrawPitchedRoofs();
        const roundedCornerDistanceInMeters = layer.layout.get('fill-extrusion-rounded-corner-distance');
        const roundedCornerDistance = roundedCornerDistanceInMeters > 0 ? getTileUnitsForMeters(roundedCornerDistanceInMeters, canonical) : 0;
        const needGeometry = layer._featureFilter.needGeometry;

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            if (!layer._featureFilter.filter(globalProperties, evaluationFeature, canonical)) continue;

            const rawGeometry = needGeometry ? evaluationFeature.geometry : loadGeometry(feature);
            const bucketFeature: FillExtrusionFeature = {
                id,
                sourceLayerIndex,
                index,
                geometry: rawGeometry,
                properties: feature.properties,
                type: feature.type,
                patterns: {}
            };

            const roofStyle = mayDrawRoofs ? evaluateRoofStyle(bucketFeature, layer, canonical) : FLAT_ROOF_STYLE;
            const pitchedShape = roofStyle.shape !== 'flat';
            if (mayDrawRoofs) bucketFeature.roofStyle = roofStyle;
            bucketFeature.geometry = pitchedShape ? rawGeometry : roundPolygonCornersIfNeeded(rawGeometry, roundedCornerDistance);
            const sliced = pitchedShape ? getSlicedPolygons(feature) : undefined;
            if (sliced) bucketFeature.roofPolygons = slicedRoofPolygons(sliced, feature.extent);
            if (pitchedShape) bucketFeature.roofOutline = options.roofOutlines?.[layer.sourceLayer]?.[String(id)];

            if (this.hasDependencies) {
                this.features.push(addPatternDependencies('fill-extrusion', this.layers, bucketFeature, {zoom: this.zoom}, options));
            } else {
                this.addFeature(bucketFeature, bucketFeature.geometry, index, canonical, {}, options.subdivisionGranularity, roofStyle);
            }

            options.featureIndex.insert(feature, bucketFeature.geometry, index, sourceLayerIndex, this.index, true);
        }
    }

    addFeatures({options, canonical, patternPositions}: BucketDependencyParameters): void {
        const layer = this.layers[0];
        const mayDrawRoofs = layer.mayDrawPitchedRoofs();
        for (const feature of this.features) {
            const {geometry} = feature;
            const roofStyle = feature.roofStyle ?? (mayDrawRoofs ? evaluateRoofStyle(feature, layer, canonical) : FLAT_ROOF_STYLE);
            this.addFeature(feature, geometry, feature.index, canonical, patternPositions, options.subdivisionGranularity, roofStyle);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike, imagePositions: {[_: string]: ImagePosition}): void {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {
            imagePositions
        });
    }

    isEmpty(): boolean {
        return this.layoutVertexArray.length === 0 && this.centroidVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.centroidVertexBuffer = context.createVertexBuffer(this.centroidVertexArray, centroidAttributes.members, true);
            if (this.roofVertexArray) {
                this.roofVertexBuffer = context.createVertexBuffer(this.roofVertexArray, roofAttributes.members);
            }
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy(): void {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.centroidVertexBuffer.destroy();
        if (this.roofVertexBuffer) {
            this.roofVertexBuffer.destroy();
        }
    }

    private enableRoofAttributes(): void {
        if (this.usesRoofAttributes) return;
        this.usesRoofAttributes = true;
        this.roofVertexArray = new PosArray();
        const missing = this.layoutVertexArray.length;
        for (let i = 0; i < missing; i++) {
            this.roofVertexArray.emplaceBack(-1, 0);
        }
    }

    private addLayoutVertex(
        x: number,
        y: number,
        nx: number,
        ny: number,
        nz: number,
        t: number,
        e: number,
        roofFraction: number,
        roofHeight: number,
    ): void {
        addVertex(this.layoutVertexArray, Math.round(x), Math.round(y), nx, ny, nz, t, e);
        if (this.usesRoofAttributes) {
            this.roofVertexArray.emplaceBack(encodeRoofFraction(roofFraction), roofHeight);
        }
    }

    private roofPolygons(geometry: Point[][]): ExtrudedPolygon[] {
        return extrudedPolygons(geometry, (outer) => isHeldWholeByEveryTile(outer, this.tileBuffer));
    }

    addFeature(
        feature: FillExtrusionFeature,
        geometry: Point[][],
        index: number,
        canonical: CanonicalTileID,
        imagePositions: {[_: string]: ImagePosition},
        subdivisionGranularity: SubdivisionGranularitySetting,
        roofStyle: RoofStyle = FLAT_ROOF_STYLE,
    ): void {
        if (roofStyle.shape === 'flat') {
            for (const footprint of classifyRings(geometry, EARCUT_MAX_RINGS)) {
                const centroid: CentroidAccumulator = {x: 0, y: 0, sampleCount: 0};
                const oldVertexCount = this.layoutVertexArray.length;

                this.processPolygon(centroid, canonical, feature, footprint, subdivisionGranularity, null, false);

                const addedVertices = this.layoutVertexArray.length - oldVertexCount;
                const centroidX = clampInt16(Math.floor(centroid.x / centroid.sampleCount));
                const centroidY = clampInt16(Math.floor(centroid.y / centroid.sampleCount));

                for (let i = 0; i < addedVertices; i++) {
                    this.centroidVertexArray.emplaceBack(centroidX, centroidY);
                }
            }
            this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions, canonical});
            return;
        }

        const polygons = feature.roofPolygons ?? this.roofPolygons(geometry);

        for (const {footprint, whole} of polygons) {
            // Compute polygon centroid to calculate elevation in GPU
            const centroid: CentroidAccumulator = {x: 0, y: 0, sampleCount: 0};
            const oldVertexCount = this.layoutVertexArray.length;
            const frame = !whole && feature.roofOutline ?
                buildOutlineFrame(feature.roofOutline, roofStyle.direction) :
                undefined;
            const pitched = whole || frame !== undefined || (roofStyle.roofHeight ?? 0) > 0;
            const metersPerTileUnit = canonical && pitched ? metersPerTileUnitAt(frame?.center ?? footprintCenter(footprint), canonical) : 1;
            const roofInput: RoofInput = {
                ...roofStyle,
                shape: pitched ? roofStyle.shape : 'flat',
                footprint,
                metersPerTileUnit,
                frame,
                clipped: !whole,
            };
            if (pitched) {
                this.enableRoofAttributes();
            }

            this.processPolygon(centroid, canonical, feature, footprint, subdivisionGranularity, roofInput, pitched);

            const addedVertices = this.layoutVertexArray.length - oldVertexCount;
            const centroidX = clampInt16(Math.floor(centroid.x / centroid.sampleCount));
            const centroidY = clampInt16(Math.floor(centroid.y / centroid.sampleCount));

            for (let i = 0; i < addedVertices; i++) {
                this.centroidVertexArray.emplaceBack(
                    centroidX,
                    centroidY
                );
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {imagePositions, canonical});
    }

    private processPolygon(
        centroid: CentroidAccumulator,
        canonical: CanonicalTileID,
        feature: BucketFeature,
        polygon: Point[][],
        subdivisionGranularity: SubdivisionGranularitySetting,
        roofInput: RoofInput | null,
        pitched: boolean,
    ): void {
        if (polygon.length < 1 || isEntirelyOutside(polygon[0])) {
            return;
        }

        // Only consider the un-subdivided polygon outer ring for centroid calculation
        for (const ring of polygon) {
            if (ring.length === 0) {
                continue;
            }

            // Here we don't mind if a hole ring is entirely outside, unlike when generating geometry later.
            accumulatePointsToCentroid(centroid, ring);
        }

        const segmentReference = {
            segment: this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray)
        };
        const granularity = subdivisionGranularity.fill.getGranularityForZoomLevel(canonical.z);
        const isPolygon = VectorTileFeature.types[feature.type] === 'Polygon';

        const subdividedFootprint: Point[][] = [];
        let roofGeometry: RoofGeometry | null = null;
        const whole = pitched && !roofInput.clipped;

        if (pitched) {
            for (const ring of polygon) {
                subdividedFootprint.push(ring.length === 0 ? ring : subdivideVertexLine(ring, granularity, isPolygon));
            }
            roofGeometry = buildRoof({...roofInput, footprint: subdividedFootprint});
        }
        const roofHeight = storedRoofHeight(roofGeometry, roofInput?.roofHeight);
        const wallProfile = roofGeometry && this.usesRoofAttributes ? roofGeometry.wallProfile : null;

        for (let ringIndex = 0; ringIndex < polygon.length; ringIndex++) {
            const ring = polygon[ringIndex];
            if (ring.length === 0 || (!whole && isEntirelyOutside(ring))) {
                continue;
            }

            const subdividedRing = pitched
                ? subdividedFootprint[ringIndex]
                : subdivideVertexLine(ring, granularity, isPolygon);

            this._generateSideFaces(subdividedRing, segmentReference, wallProfile, roofHeight, whole);
        }

        // Only triangulate and draw the area of the feature if it is a polygon
        // Other feature types (e.g. LineString) do not have area, so triangulation is pointless / undefined
        if (!isPolygon)
            return;

        if (pitched && roofGeometry) {
            this._emitRoofCap(clipRoofMesh(roofGeometry, -this.tileBuffer, EXTENT + this.tileBuffer), roofHeight);
            return;
        }

        // Do not generate outlines, since outlines already got subdivided earlier.
        const subdividedPolygon = subdividePolygon(polygon, canonical, granularity, false);
        fillLargeMeshArrays(
            (x, y) => {
                this.addLayoutVertex(x, y, 0, 0, 1, 1, 0, 1, 0);
            },
            this.segments,
            this.layoutVertexArray,
            this.indexArray,
            subdividedPolygon.verticesFlattened,
            subdividedPolygon.indicesTriangles
        );
    }

    private _emitRoofCap(mesh: RoofMesh, roofHeight: number): void {
        if (mesh.positions.length === 0) return;
        fillLargeMeshArrays(
            (x, y, v) => {
                const nx = mesh.normals[v * 3];
                const ny = mesh.normals[v * 3 + 1];
                const nz = mesh.normals[v * 3 + 2];
                this.addLayoutVertex(x, y, nx, ny, nz, 1, 0, mesh.fractions[v], roofHeight);
            },
            this.segments,
            this.layoutVertexArray,
            this.indexArray,
            mesh.positions,
            mesh.indices,
        );
    }

    private _emitWallQuad(
        p0: Point,
        p1: Point,
        startNx: number,
        startNy: number,
        endNx: number,
        endNy: number,
        dist: number,
        edgeDistance: number,
        f0: number,
        f1: number,
        roofHeight: number,
        segmentReference: {segment: Segment},
    ): number {
        if (segmentReference.segment.vertexLength + 4 > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
            segmentReference.segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);
        }
        if (edgeDistance + dist > 32768) edgeDistance = 0;

        this.addLayoutVertex(p1.x, p1.y, endNx, endNy, 0, 0, edgeDistance, -1, roofHeight);
        this.addLayoutVertex(p1.x, p1.y, endNx, endNy, 0, 1, edgeDistance, f1, roofHeight);

        edgeDistance += dist;

        this.addLayoutVertex(p0.x, p0.y, startNx, startNy, 0, 0, edgeDistance, -1, roofHeight);
        this.addLayoutVertex(p0.x, p0.y, startNx, startNy, 0, 1, edgeDistance, f0, roofHeight);

        const bottomRight = segmentReference.segment.vertexLength;

        // ┌──────┐
        // │ 0  1 │ Counter-clockwise winding order.
        // │      │ Triangle 1: 0 => 2 => 1
        // │ 2  3 │ Triangle 2: 1 => 2 => 3
        // └──────┘
        this.indexArray.emplaceBack(bottomRight, bottomRight + 2, bottomRight + 1);
        this.indexArray.emplaceBack(bottomRight + 1, bottomRight + 2, bottomRight + 3);

        segmentReference.segment.vertexLength += 4;
        segmentReference.segment.primitiveLength += 2;
        return edgeDistance;
    }

    /**
     * Generates side faces for the supplied geometry. Assumes `geometry` to be a line string, like the output of {@link subdivideVertexLine}.
     * For rings, it is assumed that the first and last vertex of `geometry` are equal.
     */
    private _generateSideFaces(
        geometry: Point[],
        segmentReference: {segment: Segment},
        wallProfile: ((a: Point, b: Point) => WallStop[]) | null = null,
        roofHeight: number = 0,
        whole = false,
    ): void {
        let edgeDistance = 0;
        const hasRoundedCorners = !wallProfile && this.layers[0].layout.get('fill-extrusion-rounded-corner-distance') > 0;
        const wallNormals = hasRoundedCorners ? roundedWallNormals(geometry) : null;

        for (let p = 1; p < geometry.length; p++) {
            let a = geometry[p - 1];
            let b = geometry[p];
            if (whole) {
                const clipped = clipSegmentToSquare(a, b, -this.tileBuffer, EXTENT + this.tileBuffer);
                if (!clipped) continue;
                [a, b] = clipped;
            } else if (isBoundaryEdge(b, a) || (wallNormals && !wallNormals[p])) {
                continue;
            }

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const edgeLen = Math.sqrt(dx * dx + dy * dy);
            const nx = -dy / edgeLen;
            const ny = dx / edgeLen;

            if (!wallProfile) {
                const normals = wallNormals?.[p];
                const startNx = normals ? normals.start.x : nx;
                const startNy = normals ? normals.start.y : ny;
                const endNx = normals ? normals.end.x : nx;
                const endNy = normals ? normals.end.y : ny;
                edgeDistance = this._emitWallQuad(a, b, startNx, startNy, endNx, endNy, edgeLen, edgeDistance, -1, -1, roofHeight, segmentReference);
                continue;
            }

            const edgeStops = wallProfile(a, b);
            for (let s = 1; s < edgeStops.length; s++) {
                const stop0 = edgeStops[s - 1];
                const stop1 = edgeStops[s];
                const dist = edgeStops.length === 2 ? edgeLen : stop0.point.dist(stop1.point);
                edgeDistance = this._emitWallQuad(stop0.point, stop1.point, nx, ny, nx, ny, dist, edgeDistance, stop0.fraction, stop1.fraction, roofHeight, segmentReference);
            }
        }
    }
}

/**
 * Accumulates geometry to centroid. Geometry can be either a polygon ring, a line string or a closed line string.
 * In case of a polygon ring or line ring, the last vertex is ignored if it is the same as the first vertex.
 */
function accumulatePointsToCentroid(centroid: CentroidAccumulator, geometry: Point[]): void {
    for (let i = 0; i < geometry.length; i++) {
        const p = geometry[i];

        if (i === geometry.length - 1 && geometry[0].x === p.x && geometry[0].y === p.y) {
            continue;
        }

        centroid.x += p.x;
        centroid.y += p.y;
        centroid.sampleCount++;
    }
}

register('FillExtrusionBucket', FillExtrusionBucket, {omit: ['layers', 'features']});
