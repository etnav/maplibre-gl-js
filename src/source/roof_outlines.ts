import Point from '@mapbox/point-geometry';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {EXTENT} from '../data/extent.ts';
import {isClipEdge, isHeldWholeByEveryTile} from '../data/extent_bounds.ts';
import {getFeatureId} from '../data/feature_index.ts';
import {loadGeometry} from '../data/load_geometry.ts';
import {toEvaluationFeature} from '../data/evaluation_feature.ts';
import {evaluateRoofStyle} from '../data/bucket/roof/roof_shapes.ts';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {isFillExtrusionStyleLayer, type FillExtrusionStyleLayer} from '../style/style_layer/fill_extrusion_style_layer.ts';
import {CanonicalTileID} from '../tile/tile_id.ts';
import {mapObject} from '../util/util.ts';

import type {PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';
import type {StyleLayer} from '../style/style_layer.ts';

/** Unclipped building outer rings keyed by source layer and feature ID. */
export type RoofOutlines = Record<string, Record<string, Point[]>>;

export type RoofOutlineRequest = Record<string, Set<string>>;

export type TileLoader = (tileID: CanonicalTileID) => Promise<VectorTileLike | null>;

type Pieces = Point[][];

const ORIGIN_CELL = 4;

type Gathering = {
    sourceLayerId: string;
    id: string;
    pieces: Map<number, Pieces>;
};

function cellIndex(dx: number, dy: number): number {
    return (dx + 1) * 3 + dy + 1;
}

function cellDx(cell: number): number {
    return ((cell / 3) | 0) - 1;
}

function cellDy(cell: number): number {
    return (cell % 3) - 1;
}

/** Feature IDs per source layer drawn with pitched roofs and clipped by a tile border. */
export function featuresNeedingOutlines(
    tile: VectorTileLike,
    families: Record<string, StyleLayer[][]>,
    zoom: number,
    canonical: CanonicalTileID,
    promoteId: PromoteIdSpecification | undefined,
    availableImages: string[],
    holdsPiece: (feature: VectorTileFeatureLike) => boolean,
): RoofOutlineRequest {
    const parameters = new EvaluationParameters(zoom);
    const request: RoofOutlineRequest = {};

    for (const sourceLayerId in families) {
        const layer = tile.layers[sourceLayerId];
        if (!layer) continue;
        const roofLayers = pitchedRoofLayers(families[sourceLayerId], parameters, availableImages);
        if (roofLayers.length === 0) continue;

        const ids = new Set<string>();
        for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            const id = getFeatureId(feature, sourceLayerId, promoteId);
            if (feature.type !== 3 || id === undefined || id === null) continue;
            if (!roofLayers.some((roofLayer) => drawsPitchedRoof(roofLayer, feature, parameters, canonical))) continue;
            if (holdsPiece(feature)) ids.add(String(id));
        }
        if (ids.size > 0) request[sourceLayerId] = ids;
    }
    return request;
}

function pitchedRoofLayers(families: StyleLayer[][], parameters: EvaluationParameters, availableImages: string[]): FillExtrusionStyleLayer[] {
    const layers: FillExtrusionStyleLayer[] = [];
    for (const [layer] of families) {
        if (!isFillExtrusionStyleLayer(layer) || layer.isHidden(parameters.zoom, true)) continue;
        layer.recalculate(parameters, availableImages);
        if (layer.mayDrawPitchedRoofs()) layers.push(layer);
    }
    return layers;
}

function drawsPitchedRoof(layer: FillExtrusionStyleLayer, feature: VectorTileFeatureLike, parameters: EvaluationParameters, canonical: CanonicalTileID): boolean {
    const evaluationFeature = toEvaluationFeature(feature, layer._featureFilter.needGeometry);
    if (!layer._featureFilter.filter(parameters, evaluationFeature, canonical)) return false;
    return evaluateRoofStyle(evaluationFeature, layer, canonical).shape !== 'flat';
}

function isStrictlyInsideTile(geometry: Point[][]): boolean {
    for (const ring of geometry) {
        for (const p of ring) {
            if (p.x <= 0 || p.x >= EXTENT || p.y <= 0 || p.y >= EXTENT) return false;
        }
    }
    return true;
}

export function holdsPieceOf(feature: VectorTileFeatureLike, buffer: number): boolean {
    const geometry = loadGeometry(feature);
    if (isStrictlyInsideTile(geometry)) return false;
    return outerRingsOfPieces(geometry, buffer).length > 0;
}

function outerRingsOfPieces(geometry: Point[][], buffer: number): Pieces {
    const outers: Pieces = [];
    for (const polygon of classifyRings(geometry)) {
        const outer = polygon[0];
        if (outer && !isHeldWholeByEveryTile(outer, buffer)) outers.push(outer);
    }
    return outers;
}

/**
 * Reconstructs unclipped building outlines across a 2x2 tile neighbourhood via `loadTile`,
 * omitting buildings that span further or have missing neighbour tiles.
 */
export async function gatherRoofOutlines(
    tile: VectorTileLike,
    tileID: CanonicalTileID,
    request: RoofOutlineRequest,
    buffer: number,
    promoteId: PromoteIdSpecification | undefined,
    loadTile: TileLoader,
): Promise<RoofOutlines> {
    const tiles = new Map<number, VectorTileLike | null>([[ORIGIN_CELL, tile]]);
    const unavailable = new Set<number>();
    const piecesByTile = new Map<string, Map<string, Pieces>>();

    function piecesIn(cell: number, sourceLayerId: string, id: string): Pieces {
        const cacheKey = `${cell}/${sourceLayerId}`;
        let byId = piecesByTile.get(cacheKey);
        if (!byId) {
            byId = piecesByFeature(tiles.get(cell)?.layers[sourceLayerId], sourceLayerId, request[sourceLayerId], buffer, promoteId);
            piecesByTile.set(cacheKey, byId);
        }
        return byId.get(id) ?? [];
    }

    let pending: Gathering[] = [];
    for (const sourceLayerId in request) {
        for (const id of request[sourceLayerId]) {
            pending.push({sourceLayerId, id, pieces: new Map([[ORIGIN_CELL, piecesIn(ORIGIN_CELL, sourceLayerId, id)]])});
        }
    }

    const gathered: Gathering[] = [];
    while (pending.length > 0) {
        const missing = new Map<Gathering, number[]>();
        const neededCells = new Set<number>();
        for (const building of pending) {
            const reached = cellsReached(building.pieces);
            if (!reached) continue;
            const notYet = reached.filter((cell) => !building.pieces.has(cell));
            if (notYet.length === 0) {
                gathered.push(building);
                continue;
            }
            missing.set(building, notYet);
            for (const cell of notYet) {
                if (!tiles.has(cell) && !unavailable.has(cell)) neededCells.add(cell);
            }
        }

        const toLoad = [...neededCells];
        const loaded = await Promise.allSettled(toLoad.map((cell) => loadNeighbour(tileID, cell, loadTile)));
        for (let i = 0; i < loaded.length; i++) {
            const result = loaded[i];
            if (result.status === 'fulfilled') tiles.set(toLoad[i], result.value);
            else unavailable.add(toLoad[i]);
        }

        pending = [];
        for (const [building, cells] of missing) {
            if (cells.some((cell) => unavailable.has(cell))) continue;
            for (const cell of cells) building.pieces.set(cell, piecesIn(cell, building.sourceLayerId, building.id));
            pending.push(building);
        }
    }

    const outlines: RoofOutlines = {};
    for (const {sourceLayerId, id, pieces} of gathered) {
        const outline = outlineOf(pieces, buffer);
        if (outline.length < 3) continue;
        (outlines[sourceLayerId] ??= {})[id] = outline;
    }
    return outlines;
}

function piecesByFeature(
    layer: VectorTileLayerLike | undefined,
    sourceLayerId: string,
    ids: Set<string>,
    buffer: number,
    promoteId: PromoteIdSpecification | undefined,
): Map<string, Pieces> {
    const pieces = new Map<string, Pieces>();
    if (!layer) return pieces;

    for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        const id = String(getFeatureId(feature, sourceLayerId, promoteId));
        if (feature.type !== 3 || !ids.has(id)) continue;

        const geometry = loadGeometry(feature);
        if (isStrictlyInsideTile(geometry)) continue;
        const outers = outerRingsOfPieces(geometry, buffer);
        if (outers.length === 0) continue;
        const existing = pieces.get(id);
        if (existing) existing.push(...outers);
        else pieces.set(id, outers);
    }
    return pieces;
}

function loadNeighbour(tileID: CanonicalTileID, cell: number, loadTile: TileLoader): Promise<VectorTileLike | null> {
    const tilesAcross = 2 ** tileID.z;
    const y = tileID.y + cellDy(cell);
    if (y < 0 || y >= tilesAcross) return Promise.resolve(null);
    const x = ((tileID.x + cellDx(cell)) % tilesAcross + tilesAcross) % tilesAcross;
    return loadTile(new CanonicalTileID(tileID.z, x, y));
}

function cellsReached(pieces: Map<number, Pieces>): number[] | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [cell, rings] of pieces) {
        const ox = cellDx(cell) * EXTENT;
        const oy = cellDy(cell) * EXTENT;
        for (const ring of rings) {
            for (const p of ring) {
                const x = p.x + ox;
                const y = p.y + oy;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (minX > maxX) return null;

    const minCol = Math.ceil(minX / EXTENT) - 1;
    const maxCol = Math.floor(maxX / EXTENT);
    const minRow = Math.ceil(minY / EXTENT) - 1;
    const maxRow = Math.floor(maxY / EXTENT);
    if (maxCol - minCol > 1 || maxRow - minRow > 1) return null;
    if (minCol > 0 || maxCol < 0 || minRow > 0 || maxRow < 0) return null;

    const cells: number[] = [];
    for (let dx = minCol; dx <= maxCol; dx++) {
        for (let dy = minRow; dy <= maxRow; dy++) cells.push(cellIndex(dx, dy));
    }
    return cells;
}

function outlineOf(pieces: Map<number, Pieces>, buffer: number): Point[] {
    const pts: Point[] = [];
    for (const [cell, rings] of pieces) {
        const ox = cellDx(cell) * EXTENT;
        const oy = cellDy(cell) * EXTENT;
        for (const ring of rings) {
            const count = ring.length > 1 && ring[0].equals(ring[ring.length - 1]) ? ring.length - 1 : ring.length;
            if (count === 0) continue;
            for (let i = 0; i < count; i++) {
                const prev = ring[(i + count - 1) % count];
                const curr = ring[i];
                const next = ring[(i + 1) % count];
                if (isClipEdge(prev, curr, buffer) || isClipEdge(curr, next, buffer)) continue;
                pts.push(new Point(curr.x + ox, curr.y + oy));
            }
        }
    }
    if (pts.length === 0) return pts;
    pts.sort((a, b) => a.x - b.x || a.y - b.y);
    const unique: Point[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = unique[unique.length - 1];
        if (pts[i].x !== prev.x || pts[i].y !== prev.y) unique.push(pts[i]);
    }
    return unique;
}

/** Transforms outlines from `maxZoomTileID` into the overzoomed `tileID` coordinate space. */
export function outlinesInSlice(outlines: RoofOutlines, maxZoomTileID: CanonicalTileID, tileID: CanonicalTileID): RoofOutlines {
    const scale = 2 ** (tileID.z - maxZoomTileID.z);
    const offsetX = (tileID.x - maxZoomTileID.x * scale) * EXTENT;
    const offsetY = (tileID.y - maxZoomTileID.y * scale) * EXTENT;
    return mapObject(outlines, (byId) => mapObject(byId, (outline) =>
        outline.map((p) => new Point(p.x * scale - offsetX, p.y * scale - offsetY))));
}
