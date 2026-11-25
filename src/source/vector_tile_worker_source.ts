import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {fromVectorTileJs, type VectorTileFeatureLike, type VectorTileLike} from '@maplibre/vt-pbf';
import {type AJAXError, type ExpiryData, getArrayBuffer, type RequestParameters} from '../util/ajax.ts';
import {WorkerTile} from './worker_tile.ts';
import {WorkerTileState} from './worker_tile_state.ts';
import {BoundedLRUCache} from '../tile/tile_cache.ts';
import {ensureError} from '../util/util.ts';
import {RequestPerformance} from '../util/request_performance.ts';
import {VectorTileOverzoomed, getSlicedPolygons, sliceVectorTileLayer} from './vector_tile_overzoomed.ts';
import {MLTVectorTile} from './vector_tile_mlt.ts';
import {featuresNeedingOutlines, gatherRoofOutlines, holdsPieceOf, outlinesInSlice, type RoofOutlines} from './roof_outlines.ts';
import {DEFAULT_TILE_BUFFER} from '../data/extent_bounds.ts';
import {MessageType} from '../util/actor_messages.ts';
import {throwIfAborted} from '../util/abort_error.ts';

import type {
    WorkerSource,
    WorkerTileParameters,
    TileParameters,
    WorkerTileResult
} from '../source/worker_source.ts';
import type {IActor} from '../util/actor.ts';
import type {StyleLayerIndex} from '../style/style_layer_index.ts';
import type {CanonicalTileID} from '../tile/tile_id.ts';

const GATHERED_TILE_CACHE_SIZE = 32;

export type LoadVectorTileResult = {
    vectorTile: VectorTileLike;
    rawData: ArrayBuffer;
};

/**
 * The {@link WorkerSource} implementation that supports {@link VectorTileSource}. This class is
 * used by vector tile sources to perform tile processing operations in a separate worker thread.
 */
export class VectorTileWorkerSource implements WorkerSource {
    actor: IActor;
    layerIndex: StyleLayerIndex;
    availableImages: string[];
    tileState: WorkerTileState;
    overzoomedTileResultCache: BoundedLRUCache<string, LoadVectorTileResult>;
    gatheredTileCache: BoundedLRUCache<string, Promise<VectorTileLike | null>>;

    constructor(actor: IActor, layerIndex: StyleLayerIndex, availableImages: string[]) {
        this.actor = actor;
        this.layerIndex = layerIndex;
        this.availableImages = availableImages;
        this.tileState = new WorkerTileState();
        this.overzoomedTileResultCache = new BoundedLRUCache<string, LoadVectorTileResult>(1000);
        this.gatheredTileCache = new BoundedLRUCache<string, Promise<VectorTileLike | null>>(GATHERED_TILE_CACHE_SIZE);
    }

    /**
     * Loads a vector tile
     */
    loadVectorTile(params: WorkerTileParameters, rawData: ArrayBuffer): LoadVectorTileResult {
        try {
            const vectorTile = params.encoding !== 'mlt'
                ? new VectorTile(new PbfReader(rawData))
                : new MLTVectorTile(rawData);

            return {vectorTile, rawData};
        } catch (ex) {
            const bytes = new Uint8Array(rawData);
            const isGzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
            let errorMessage = `Unable to parse the tile at ${params.request.url}, `;
            if (isGzipped) {
                errorMessage += 'please make sure the data is not gzipped and that you have configured the relevant header in the server';
            } else {
                errorMessage += `got error: ${ensureError(ex).message}`;
            }
            throw new Error(errorMessage);
        }
    }

    /**
     * Implements {@link WorkerSource.loadTile}.
     * An unchanged ETag skips parsing only when this worker holds a decoded copy of that version,
     * which is what a later `reloadTile` reparses; otherwise the response is parsed and stored like a new tile.
     */
    async loadTile(params: WorkerTileParameters): Promise<WorkerTileResult | null> {
        const {uid, overzoomParameters} = params;

        if (overzoomParameters) {
            params.request = overzoomParameters.overzoomRequest;
        }

        const timing = this._startRequestTiming(params);
        const workerTile = new WorkerTile(params);

        this.tileState.startLoading(uid, workerTile);
        const abortController = new AbortController();
        workerTile.abort = abortController;
        try {
            // Download the tile data from the network.
            const tileResponse = await getArrayBuffer(params.request, abortController);

            const loadedTile = this.tileState.getLoaded(uid);
            // Tile data hasn't changed (etag support) - return an unmodified result
            if (params.etag && params.etag === tileResponse.etag && loadedTile?.etag === tileResponse.etag) {
                this.tileState.finishLoading(uid);
                return this._getEtagUnmodifiedResult(tileResponse, timing);
            }

            const tileResult = this.loadVectorTile(params, tileResponse.data);
            if (!tileResult) {
                this.tileState.finishLoading(uid);
                return null;
            }

            let {vectorTile, rawData} = tileResult;
            const clippedTile = vectorTile;
            if (overzoomParameters) {
                ({vectorTile, rawData} = this._getOverzoomTile(params, vectorTile));
            }
            workerTile.roofOutlines = await this._gatherRoofOutlines(params, vectorTile, clippedTile);
            throwIfAborted(abortController.signal);
            this.tileState.finishLoading(uid);

            const cacheControl = this._getExpiryData(tileResponse);
            const resourceTiming = this._finishRequestTiming(timing);

            workerTile.vectorTile = vectorTile;
            workerTile.etag = tileResponse.etag;
            this.tileState.markLoaded(uid, workerTile);
            const parsingState = {rawData, cacheControl, resourceTiming};
            this.tileState.setParsing(uid, parsingState);

            return await this._parseWorkerTile(workerTile, params);
        } catch (err) {
            this.tileState.finishLoading(uid);
            this.tileState.markLoaded(uid, workerTile);
            throw err;
        }
    }

    _getEtagUnmodifiedResult(response: ExpiryData, timing: RequestPerformance): WorkerTileResult {
        const cacheControl = this._getExpiryData(response);
        const resourceTiming = this._finishRequestTiming(timing);
        return {etagUnmodified: true as const, ...cacheControl, ...resourceTiming};
    }

    async _parseWorkerTile(workerTile: WorkerTile, params: WorkerTileParameters): Promise<WorkerTileResult> {
        const parseState = this.tileState.getParsing(workerTile.uid);

        let result = await workerTile.parse(workerTile.vectorTile, this.layerIndex, this.availableImages, this.actor, params.subdivisionGranularity);

        // We need to pass rawTileData back to the main thread so that it can be stored in the Tile and FeatureIndex.
        // After the main thread has successfully received and stored rawTileData,
        // we no longer need to store it in the worker or transfer additional copies of it.
        if (parseState) {
            const {rawData, cacheControl, resourceTiming} = parseState;
            // Overzoomed tiles are always re-encoded to MVT protobuf by _getOverzoomTile
            const encoding = params.overzoomParameters ? 'mvt' : params.encoding;
            // Return a copy of rawData to the main thread to avoid clearing the worker's buffer
            result = {rawTileData: rawData.slice(0), encoding, ...result, ...cacheControl, ...resourceTiming};
            this.tileState.removeParsing(workerTile.uid);
        } else if (workerTile.etag) {
            // Reload: return the stored etag since the main thread overwrites the tile's etag with every
            // result (#3309). cacheControl/expires are deliberately not re-sent: the main thread anchors
            // max-age to the time it receives them, and the tile's expiration already survives a reload.
            result = {...result, etag: workerTile.etag};
        }

        return result;
    }

    _getExpiryData({expires, cacheControl, etag}: ExpiryData): ExpiryData {
        const data: ExpiryData = {};
        if (expires) data.expires = expires;
        if (cacheControl) data.cacheControl = cacheControl;
        if (etag) data.etag = etag;
        return data;
    }

    _startRequestTiming(params: WorkerTileParameters): RequestPerformance | undefined {
        if (!params.request?.collectResourceTiming) return;
        return new RequestPerformance(params.request.url);
    }

    _finishRequestTiming(timing: RequestPerformance): {resourceTiming?: PerformanceResourceTiming[]} {
        const timingData = timing?.finish();
        if (!timingData) return {};

        // it's necessary to eval the result of getEntriesByName() here via parse/stringify
        // late evaluation in the main thread causes TypeError: illegal invocation
        return {resourceTiming: JSON.parse(JSON.stringify(timingData))};
    }

    /**
     * If we are seeking a tile deeper than the source's max available canonical tile, get the overzoomed tile
     * @param params - the worker tile parameters
     * @param maxZoomVectorTile - the original vector tile at the source's max available canonical zoom
     * @returns the overzoomed tile and its raw data
     */
    private _getOverzoomTile(params: WorkerTileParameters, maxZoomVectorTile: VectorTileLike): LoadVectorTileResult {
        const {tileID, source, overzoomParameters} = params;
        const {maxZoomTileID} = overzoomParameters;
        const layerFamilies = this.layerIndex.familiesBySource?.[source] ?? {};
        const extrudedSourceLayers = Object.keys(layerFamilies)
            .filter((sourceLayerId) => layerFamilies[sourceLayerId].some((family) => family[0].type === 'fill-extrusion'));

        const cacheKey = extrudedSourceLayers.length ?
            `${maxZoomTileID.key}_${tileID.key}_${params.request?.url}_${extrudedSourceLayers.join()}` :
            `${maxZoomTileID.key}_${tileID.key}_${params.request?.url}`;
        const cachedOverzoomTile = this.overzoomedTileResultCache.get(cacheKey);

        if (cachedOverzoomTile) {
            return cachedOverzoomTile;
        }

        const overzoomedVectorTile = new VectorTileOverzoomed();

        for (const sourceLayer of Object.values(maxZoomVectorTile.layers)) {
            const keepPolygons = extrudedSourceLayers.includes(sourceLayer.name);
            const slicedTileLayer = sliceVectorTileLayer(sourceLayer, maxZoomTileID, tileID.canonical, keepPolygons);
            if (slicedTileLayer.length > 0) {
                overzoomedVectorTile.addLayer(slicedTileLayer);
            }
        }
        const overzoomedVectorTileResult = {
            vectorTile: overzoomedVectorTile,
            rawData: fromVectorTileJs(overzoomedVectorTile).buffer as ArrayBuffer
        };
        this.overzoomedTileResultCache.set(cacheKey, overzoomedVectorTileResult);

        return overzoomedVectorTileResult;
    }

    /**
     * Implements {@link WorkerSource.reloadTile}.
     */
    async reloadTile(params: WorkerTileParameters): Promise<WorkerTileResult> {
        const uid = params.uid;
        const workerTile = this.tileState.getLoaded(uid);
        if (!workerTile) throw new Error('Should not be trying to reload a tile that was never loaded or has been removed');

        // If there was no vector tile data on the initial load, don't try to reparse the tile.
        if (!workerTile.vectorTile) {
            return;
        }

        workerTile.showCollisionBoxes = params.showCollisionBoxes;
        workerTile.tileID = workerTile.tileID.unwrapTo(params.tileID.wrap);
        workerTile.roofOutlines = await this._gatherRoofOutlines(params, workerTile.vectorTile);
        return await this._parseWorkerTile(workerTile, params);
    }

    /** Gathers unclipped building outlines from neighbouring tiles for tile-split pitched roofs. */
    async _gatherRoofOutlines(params: WorkerTileParameters, tile: VectorTileLike, clippedTile?: VectorTileLike): Promise<RoofOutlines> {
        const {source, tileID, overzoomParameters, promoteId} = params;
        const families = this.layerIndex.familiesBySource?.[source];
        if (!families) return {};

        function holdsPiece(feature: VectorTileFeatureLike): boolean {
            return overzoomParameters ?
                (getSlicedPolygons(feature)?.pieces.length ?? 0) > 0 :
                holdsPieceOf(feature, DEFAULT_TILE_BUFFER);
        }

        const request = featuresNeedingOutlines(tile, families, tileID.overscaledZ, tileID.canonical, promoteId, this.availableImages, holdsPiece);
        if (Object.keys(request).length === 0) return {};

        const clippedTileID = overzoomParameters?.maxZoomTileID ?? tileID.canonical;
        const clippedRequest = overzoomParameters?.overzoomRequest ?? params.request;
        if (clippedTile) this.gatheredTileCache.set(clippedRequest.url, Promise.resolve(clippedTile));
        const clipped = overzoomParameters ? await this._loadGatheredTile(params, clippedRequest).catch(() => null) : tile;
        if (!clipped) return {};

        const outlines = await gatherRoofOutlines(clipped, clippedTileID, request, DEFAULT_TILE_BUFFER, promoteId,
            async (id) => this._loadGatheredTile(params, await this._requestTileOfSource(source, id)));
        return overzoomParameters ? outlinesInSlice(outlines, clippedTileID, tileID.canonical) : outlines;
    }

    async _requestTileOfSource(source: string, tileID: CanonicalTileID): Promise<RequestParameters> {
        const [request] = await this.actor.sendAsync({type: MessageType.getTileRequests, data: {source, tileIDs: [tileID]}});
        return request;
    }

    _loadGatheredTile(params: WorkerTileParameters, request: RequestParameters): Promise<VectorTileLike | null> {
        const cached = this.gatheredTileCache.get(request.url);
        if (cached) return cached;

        const loading = this._fetchGatheredTile(params, request);
        this.gatheredTileCache.set(request.url, loading);
        loading.catch(() => this.gatheredTileCache.delete(request.url));
        return loading;
    }

    async _fetchGatheredTile(params: WorkerTileParameters, request: RequestParameters): Promise<VectorTileLike | null> {
        try {
            const response = await getArrayBuffer(request, new AbortController());
            return this.loadVectorTile({...params, request}, response.data).vectorTile;
        } catch (err) {
            if ((err as AJAXError).status === 404) return null;
            throw err;
        }
    }

    /**
     * Implements {@link WorkerSource.abortTile}.
     */
    async abortTile(params: TileParameters): Promise<void> {
        this.tileState.abort(params.uid);
    }

    /**
     * Implements {@link WorkerSource.removeTile}.
     */
    async removeTile(params: TileParameters): Promise<void> {
        this.tileState.removeLoaded(params.uid);
    }
}
