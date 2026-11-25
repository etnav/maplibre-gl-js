import Point from '@mapbox/point-geometry';
import {Bounds, type ReadOnlyBounds} from '../geo/bounds.ts';
import {EXTENT} from './extent.ts';

import type {Point2D} from '@maplibre/maplibre-gl-style-spec';

/**
 * The bounding box covering the entire extent of a tile.
 */
export const EXTENT_BOUNDS = Bounds.fromPoints([new Point(0, 0), new Point(EXTENT, EXTENT)]) as ReadOnlyBounds;

/**
 * Whether an edge runs along one of the lines the tile was cut out of the world at. Clipping happens
 * on the buffer rectangle, outside the tile, so an axis parallel edge out there belongs to the cut
 * rather than to the feature. Such an edge is shared with the neighbouring tile, which cuts the same
 * feature somewhere else, so geometry derived from it has to stay identical in both tiles.
 * @param p1 - First vertex of the edge
 * @param p2 - Second vertex of the edge
 * @returns True when the edge lies on a clip line.
 */
export function isBoundaryEdge(p1: Point2D, p2: Point2D): boolean {
    return (p1.x === p2.x && (p1.x < 0 || p1.x > EXTENT)) ||
        (p1.y === p2.y && (p1.y < 0 || p1.y > EXTENT));
}

/**
 * Whether a ring lies completely off one side of the tile, and so cannot contribute a visible pixel.
 * @param ring - Ring to test
 * @returns True when every vertex is beyond the same edge of the tile.
 */
export function isEntirelyOutside(ring: Point2D[]): boolean {
    return ring.every(p => p.x < 0) ||
        ring.every(p => p.x > EXTENT) ||
        ring.every(p => p.y < 0) ||
        ring.every(p => p.y > EXTENT);
}

/**
 * Whether a point lies outside the tile, in the buffer the neighbouring tile draws.
 * @param p - Point to test
 * @returns True when the point is beyond the left or top edge, or on or beyond the right or bottom edge.
 */
export function isOutsideTile(p: Point2D): boolean {
    return p.x < 0 || p.x >= EXTENT || p.y < 0 || p.y >= EXTENT;
}

export const DEFAULT_TILE_BUFFER = 128;

/** Whether an axis-aligned edge lies on a tile or buffer clip boundary. */
export function isClipEdge(a: Point2D, b: Point2D, buffer: number, extent: number = EXTENT): boolean {
    if (a.x === b.x) {
        return a.x === 0 || a.x === extent || a.x === -buffer || a.x === extent + buffer;
    }
    if (a.y === b.y) {
        return a.y === 0 || a.y === extent || a.y === -buffer || a.y === extent + buffer;
    }
    return false;
}

function fitsBorderBuffer(min: number, max: number, buffer: number, extent: number): boolean {
    if (min <= 0 && (min < -buffer || max > buffer)) return false;
    if (max >= extent && (max > extent + buffer || min < extent - buffer)) return false;
    return true;
}

/** Whether `ring` has no clip edges and stays within `buffer` past any tile border it touches. */
export function isHeldWholeByEveryTile(ring: Point2D[], buffer: number, extent: number = EXTENT): boolean {
    if (ring.length < 2) return false;

    let minX = ring[0].x;
    let maxX = minX;
    let minY = ring[0].y;
    let maxY = minY;
    for (let i = 1; i < ring.length; i++) {
        const p = ring[i];
        if (isClipEdge(ring[i - 1], p, buffer, extent)) return false;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    return fitsBorderBuffer(minX, maxX, buffer, extent) && fitsBorderBuffer(minY, maxY, buffer, extent);
}
