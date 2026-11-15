import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  untracked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { isAtMost } from '@kmd/design-system/utils/breakpoints';
import { I18nService } from '../../core/i18n/i18n.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { WildfireStateService, ringToClosedPolygonCoords } from '../../core/services/wildfire-state.service';
import { HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';
import { ColorRampService } from '../../core/services/color-ramp.service';
import { GlobeTileService, SAT_MAX_ZOOM, TileProviderId } from '../../core/services/globe-tile.service';
import { BoundingBox, MultiPolygonCoords, PolygonCoords, PolygonRing } from '../../core/models/wildfire.model';
import { ScreenPt, findNearestEdgePx, findNearestVertexPx } from '../../core/utils/polygon-clip';
import { USER_LOCATION_PIN_COLOR, drawUserLocationPin } from '../../core/utils/location-pin';
import { getUnobstructedViewportBounds } from '../../core/utils/viewport-framing';
import {
  GlowEdge,
  STATIC_GLOW_LEVEL,
  hotspotGlowRgb,
  clusterOutlineEdges,
  hotspotGlowIsResting,
  hotspotGlowLevel,
  prefersReducedMotion
} from '../../core/utils/hotspot-glow';

interface CachedTile {
  status: 'loading' | 'ready' | 'error';
  img: HTMLImageElement;
  lastUsed: number;
}

interface BorderRingBbox {
  ring: [number, number][];
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 4.0;
const MAX_ZOOM = 14;
/** Max zoom-out framing reference covering the full Iberian Peninsula and France. */
const MAX_ZOOM_OUT_BBOX: BoundingBox = [-9.6, 35.8, 9.6, 51.2];
const MAX_MERCATOR_LAT = 85.05112878;
const MAX_CACHED_TILES = 320;

@Component({
  selector: 'app-map2d',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './map2d.component.html',
  styleUrl: './map2d.component.scss'
})
export class Map2dComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapCanvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('glowCanvas', { static: true }) glowCanvasRef!: ElementRef<HTMLCanvasElement>;

  readonly i18n = inject(I18nService);
  private readonly ngZone = inject(NgZone);
  private readonly hostRef = inject(ElementRef<HTMLElement>);
  private readonly data = inject(WildfireDataService);
  private readonly state = inject(WildfireStateService);
  private readonly analytics = inject(HotspotAnalyticsService);
  private readonly ramps = inject(ColorRampService);
  private readonly tiles = inject(GlobeTileService);

  private ctx: CanvasRenderingContext2D | null = null;
  private glowCtx: CanvasRenderingContext2D | null = null;
  private glowEdges: GlowEdge[] = [];
  private glowStart = 0;
  private glowRaf: number | null = null;
  private glowLastLevel = -1;
  private glowLastDraw = 0;
  private width = 1280;
  private height = 800;
  private dpr = 1;
  private rafPending = false;
  private resizeObserver: ResizeObserver | null = null;

  // Map camera state in geographic center + continuous fractional Web Mercator zoom
  private centerLon = -7.86;
  private centerLat = 40.21;
  private zoom = 9.5;
  private lastReportedTileZoom = -1;

  // Tile & administrative border caches
  private readonly tileCache = new Map<string, CachedTile>();
  private borderStateRings: BorderRingBbox[] = [];
  private borderCountryRings: BorderRingBbox[] = [];
  private bordersLoaded = false;
  private bordersLoading = false;

  // Pointer interaction state
  private readonly activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;
  private lastPinchMidX = 0;
  private lastPinchMidY = 0;
  private isPanning = false;
  private panLastClientX = 0;
  private panLastClientY = 0;
  private isDraggingBbox = false;
  private drawAnchorLonLat: [number, number] | null = null;
  private draggingVertexIdx: number | null = null;

  constructor() {
    effect(() => {
      // Re-render when region geometry, hotspots, ramp, or visibility toggles change
      this.state.liveDrawBbox();
      this.state.draftPolygon();
      this.state.regionMultiPolygon();
      this.state.drawBoxMode();
      this.state.showRegionBbox();
      this.analytics.globePixelSquares();
      this.state.regionPolygon();
      this.state.colorRamp();
      this.state.showHotspotsOnGlobe();
      this.state.showLandOrtho();
      this.state.showBorders();
      this.state.showUserLocation();
      this.state.userLocation();
      untracked(() => this.requestRender());
    });

    // Cluster outline for the pulsing glow: rebuilt when hotspots or the region change,
    // and the pulse restarts (two quick beats, then one every 3 s).
    effect(() => {
      const squares = this.analytics.globePixelSquares();
      const multi = this.state.regionMultiPolygon();
      untracked(() => {
        this.glowEdges = squares.length && multi.length ? clusterOutlineEdges(squares, multi) : [];
        this.glowStart = performance.now();
        this.glowLastLevel = -1;
        this.startGlowLoop();
      });
    });

    let focusInitialized = false;
    effect(() => {
      const focus = this.state.cameraFocus();
      if (!focusInitialized) {
        focusInitialized = true;
        return;
      }
      untracked(() => {
        this.state.userCamera2d.set(null);
        if (focus === 'iberia') {
          const bbox = this.state.regionBbox();
          if (bbox) {
            this.fitBboxToViewport(bbox);
          } else {
            this.centerLon = -5.5;
            this.centerLat = 40.3;
            this.zoom = Math.max(this.effectiveMinZoom(), 6);
          }
        } else if (focus === 'northAtlantic') {
          this.centerLon = -48;
          this.centerLat = 35;
          this.zoom = Math.max(this.effectiveMinZoom(), 4);
        } else {
          this.centerLon = -140;
          this.centerLat = 0;
          this.zoom = Math.max(this.effectiveMinZoom(), 3.2);
        }
        this.clampCameraBounds();
        this.requestRender();
      });
    });

    let panelFramingInitialized = false;
    effect(() => {
      this.state.isAnalyticsMinimized();
      this.state.isAnalyticsExpanded();
      if (!panelFramingInitialized) {
        panelFramingInitialized = true;
        return;
      }
      untracked(() => {
        if (!this.ctx || isAtMost('tablet') || this.state.userCamera2d() !== null) return;
        const bbox = this.state.regionBbox();
        if (bbox) {
          this.fitBboxToViewport(bbox);
          this.requestRender();
        }
      });
    });

    let lastFlyTrigger = untracked(() => this.state.flyToBboxTrigger());
    effect(() => {
      const trigger = this.state.flyToBboxTrigger();
      if (trigger > lastFlyTrigger) {
        lastFlyTrigger = trigger;
        const bbox = untracked(() => this.state.regionBbox());
        if (bbox) {
          untracked(() => {
            this.fitBboxToViewport(bbox);
            this.requestRender();
          });
        }
      }
    });

    effect(() => {
      const drawing = this.state.isDrawingBbox();
      const canvas = this.canvasRef?.nativeElement;
      if (canvas) {
        canvas.style.cursor = drawing ? 'crosshair' : 'grab';
      }
    });
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d');
    this.glowCtx = this.glowCanvasRef.nativeElement.getContext('2d');
    this.updateCanvasSize();

    const saved = this.state.userCamera2d();
    const initialBbox = this.state.regionBbox();
    if (saved) {
      this.centerLon = saved.lon;
      this.centerLat = saved.lat;
      this.zoom = saved.zoom;
      this.clampCameraBounds();
    } else if (initialBbox) {
      this.fitBboxToViewport(initialBbox);
    }

    this.ngZone.runOutsideAngular(() => {
      canvas.addEventListener('wheel', this.onWheel, { passive: false });
      window.addEventListener('resize', this.onResize);
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.hostRef.nativeElement);
      }
    });

    this.state.mapLoaded.set(true);
    this.syncZoomSignal();
    this.requestRender();
    void this.data.loadAll();
  }

  ngOnDestroy(): void {
    const canvas = this.canvasRef?.nativeElement;
    canvas?.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.tileCache.clear();
    if (this.glowRaf !== null) cancelAnimationFrame(this.glowRaf);
    this.glowRaf = null;
  }

  private readonly onResize = () => {
    this.updateCanvasSize();
    if (this.state.userCamera2d() === null) {
      const bbox = this.state.regionBbox();
      if (bbox) {
        this.fitBboxToViewport(bbox);
      } else {
        this.clampCameraBounds();
      }
    } else {
      this.clampCameraBounds();
    }
    this.requestRender();
  };

  private updateCanvasSize(): void {
    const canvas = this.canvasRef.nativeElement;
    const rect = this.hostRef.nativeElement.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width || window.innerWidth));
    this.height = Math.max(1, Math.round(rect.height || window.innerHeight));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(this.width * this.dpr);
    canvas.height = Math.round(this.height * this.dpr);
    const glow = this.glowCanvasRef?.nativeElement;
    if (glow) {
      glow.width = canvas.width;
      glow.height = canvas.height;
    }
  }

  private requestRender(): void {
    if (this.rafPending || !this.ctx) return;
    this.rafPending = true;
    this.ngZone.runOutsideAngular(() => {
      requestAnimationFrame(() => {
        this.rafPending = false;
        this.render();
      });
    });
  }

  private clampLat(lat: number): number {
    return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  }

  private wrapLon(lon: number): number {
    return ((((lon + 180) % 360) + 360) % 360) - 180;
  }

  private worldSize(z = this.zoom): number {
    return TILE_SIZE * Math.pow(2, z);
  }

  private lonToWorldX(lon: number, ws: number): number {
    return ((lon + 180) / 360) * ws;
  }

  private latToWorldY(lat: number, ws: number): number {
    const sin = Math.sin((this.clampLat(lat) * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
    return y * ws;
  }

  private worldXToLon(wx: number, ws: number): number {
    return (wx / ws) * 360 - 180;
  }

  private worldYToLat(wy: number, ws: number): number {
    const clampedWy = Math.max(0, Math.min(ws, wy));
    const n = Math.PI - (2 * Math.PI * clampedWy) / ws;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  private lonLatToScreen(lon: number, lat: number, ws = this.worldSize(), cx = this.lonToWorldX(this.centerLon, ws), cy = this.latToWorldY(this.centerLat, ws)): [number, number] {
    let dx = this.lonToWorldX(lon, ws) - cx;
    if (dx > ws * 0.5) dx -= ws;
    if (dx < -ws * 0.5) dx += ws;
    const dy = this.latToWorldY(lat, ws) - cy;
    return [this.width * 0.5 + dx, this.height * 0.5 + dy];
  }

  private screenToLonLat(clientX: number, clientY: number): [number, number] {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const ws = this.worldSize();
    const cx = this.lonToWorldX(this.centerLon, ws);
    const cy = this.latToWorldY(this.centerLat, ws);
    const wx = cx + (sx - this.width * 0.5);
    const wy = cy + (sy - this.height * 0.5);
    const lon = this.wrapLon(this.worldXToLon(wx, ws));
    const lat = this.clampLat(this.worldYToLat(wy, ws));
    return [Number(lon.toFixed(4)), Number(lat.toFixed(4))];
  }

  private zoomForBbox(bbox: BoundingBox, fillRatio: number, availW: number, availH: number): number {
    const [w, s, e, n] = bbox;
    const ws1 = TILE_SIZE;
    const spanX = Math.max(1e-5, (e - w) / 360) * ws1;
    const spanY = Math.max(1e-5, this.latToWorldY(s, ws1) - this.latToWorldY(n, ws1));
    const zoomX = Math.log2((availW * fillRatio) / spanX);
    const zoomY = Math.log2((availH * fillRatio) / spanY);
    return Math.min(zoomX, zoomY);
  }

  private effectiveMinZoom(): number {
    const framing = getUnobstructedViewportBounds(this.width, this.height, false, false);
    const regionMinZoom = this.zoomForBbox(MAX_ZOOM_OUT_BBOX, 0.85, framing.availW, framing.availH);
    const worldFloor = Math.log2(Math.max(this.width, this.height) / TILE_SIZE);
    return Math.max(MIN_ZOOM, worldFloor, regionMinZoom);
  }

  private setCameraCenterFromWorld(wx: number, wy: number, ws = this.worldSize()): void {
    const halfH = Math.min(ws * 0.5, this.height * 0.5);
    const clampedWy = Math.max(halfH, Math.min(ws - halfH, wy));
    this.centerLon = this.wrapLon(this.worldXToLon(wx, ws));
    this.centerLat = this.clampLat(this.worldYToLat(clampedWy, ws));
  }

  private clampCameraBounds(): void {
    this.zoom = Math.max(this.effectiveMinZoom(), Math.min(MAX_ZOOM, this.zoom));
    const ws = this.worldSize();
    this.setCameraCenterFromWorld(
      this.lonToWorldX(this.centerLon, ws),
      this.latToWorldY(this.centerLat, ws),
      ws
    );
    this.syncZoomSignal();
  }

  private persistUserCamera(): void {
    this.ngZone.run(() => {
      this.state.userCamera2d.set({
        lon: this.centerLon,
        lat: this.centerLat,
        zoom: this.zoom
      });
      this.state.cameraTargetLonLat.set([this.centerLon, this.centerLat]);
    });
  }

  private fitBboxToViewport(bbox: BoundingBox): void {
    const [w, s, e, n] = bbox;
    const framing = getUnobstructedViewportBounds(
      this.width,
      this.height,
      this.state.isAnalyticsMinimized(),
      this.state.isAnalyticsExpanded()
    );

    const fitZoom = this.zoomForBbox(bbox, 0.72, framing.availW, framing.availH);
    const minZoom = this.effectiveMinZoom();
    this.zoom = Math.max(minZoom, Math.min(Math.min(12.5, MAX_ZOOM), fitZoom));

    const ws = this.worldSize();
    const bboxMidWx = this.lonToWorldX((w + e) * 0.5, ws);
    const bboxMidWy = (this.latToWorldY(s, ws) + this.latToWorldY(n, ws)) * 0.5;
    const shiftedCx = bboxMidWx - (framing.desiredCenterX - this.width * 0.5);
    const shiftedCy = bboxMidWy - (framing.desiredCenterY - this.height * 0.5);

    this.setCameraCenterFromWorld(shiftedCx, shiftedCy, ws);
    this.syncZoomSignal();
  }

  private syncZoomSignal(): void {
    const zInt = Math.max(Math.floor(MIN_ZOOM), Math.min(MAX_ZOOM, Math.round(this.zoom)));
    if (zInt !== this.lastReportedTileZoom) {
      this.lastReportedTileZoom = zInt;
      this.ngZone.run(() => this.state.activeTileZoom.set(zInt));
    }
  }

  private getOrFetchTile(provider: TileProviderId, z: number, x: number, y: number): CachedTile {
    const key = `${provider}/${z}/${x}/${y}`;
    const existing = this.tileCache.get(key);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing;
    }

    if (this.tileCache.size >= MAX_CACHED_TILES) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, entry] of this.tileCache) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestKey = k;
        }
      }
      if (oldestKey) this.tileCache.delete(oldestKey);
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    const record: CachedTile = { status: 'loading', img, lastUsed: performance.now() };
    this.tileCache.set(key, record);

    img.onload = () => {
      record.status = 'ready';
      record.lastUsed = performance.now();
      this.requestRender();
    };
    img.onerror = () => {
      record.status = 'error';
    };
    img.src = this.tiles.buildTileUrl(provider, z, x, y);
    return record;
  }

  private drawFallbackTile(
    ctx: CanvasRenderingContext2D,
    provider: TileProviderId,
    z: number,
    wrappedX: number,
    ty: number,
    dx: number,
    dy: number,
    tilePx: number
  ): void {
    for (let dz = 1; dz <= 4; dz++) {
      const pz = z - dz;
      if (pz < 2) break;
      const factor = 1 << dz;
      const px = Math.floor(wrappedX / factor);
      const py = Math.floor(ty / factor);
      const ancestor = this.tileCache.get(`${provider}/${pz}/${px}/${py}`);
      if (ancestor?.status === 'ready' && ancestor.img.complete && ancestor.img.naturalWidth > 0) {
        const subSize = TILE_SIZE / factor;
        const sx = (wrappedX % factor) * subSize;
        const sy = (ty % factor) * subSize;
        ctx.drawImage(ancestor.img, sx, sy, subSize, subSize, dx, dy, tilePx, tilePx);
        ancestor.lastUsed = performance.now();
        return;
      }
    }
  }

  private async ensureBordersLoaded(): Promise<void> {
    if (this.bordersLoaded || this.bordersLoading) return;
    this.bordersLoading = true;
    try {
      const [statesResp, countriesResp] = await Promise.all([
        fetch('assets/data/global-states-10m.json'),
        fetch('assets/data/uk-land-10m.json')
      ]);
      const [statesGeo, countriesGeo] = await Promise.all([
        statesResp.ok ? statesResp.json() : null,
        countriesResp.ok ? countriesResp.json() : null
      ]);
      if (statesGeo) {
        this.borderStateRings = this.extractRingsWithBbox(statesGeo);
      }
      if (countriesGeo) {
        this.borderCountryRings = this.extractRingsWithBbox(countriesGeo);
      }
      this.bordersLoaded = true;
      this.requestRender();
    } catch {
      // ignore vector border fetch failures
    } finally {
      this.bordersLoading = false;
    }
  }

  private extractRingsWithBbox(geojson: any): BorderRingBbox[] {
    const out: BorderRingBbox[] = [];
    const features = geojson?.type === 'FeatureCollection' ? geojson.features : [geojson];
    const pushRing = (ring: [number, number][]) => {
      if (!ring || ring.length < 2) return;
      let minLon = 180;
      let maxLon = -180;
      let minLat = 90;
      let maxLat = -90;
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      out.push({ ring, minLon, maxLon, minLat, maxLat });
    };

    for (const f of features ?? []) {
      const g = f?.geometry ?? f;
      if (!g) continue;
      if (g.type === 'Polygon') {
        for (const r of g.coordinates) pushRing(r);
      } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) {
          for (const r of poly) pushRing(r);
        }
      }
    }
    return out;
  }

  private renderBorderRingSet(
    ctx: CanvasRenderingContext2D,
    rings: BorderRingBbox[],
    strokeStyle: string,
    lineWidth: number,
    ws: number,
    cx: number,
    cy: number,
    minViewLat: number,
    maxViewLat: number
  ): void {
    if (!rings.length) return;
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    const seamThreshold = ws * 0.4;
    for (const item of rings) {
      if (item.maxLat < minViewLat || item.minLat > maxViewLat) continue;
      let prevSx = 0;
      for (let i = 0; i < item.ring.length; i++) {
        const [lon, lat] = item.ring[i];
        const [sx, sy] = this.lonLatToScreen(lon, lat, ws, cx, cy);
        if (i === 0 || Math.abs(sx - prevSx) > seamThreshold) {
          ctx.moveTo(sx, sy);
        } else {
          ctx.lineTo(sx, sy);
        }
        prevSx = sx;
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  private renderAdministrativeBorders(ctx: CanvasRenderingContext2D, ws: number, cx: number, cy: number): void {
    this.ensureBordersLoaded();
    if (!this.bordersLoaded) return;

    const topWy = cy - this.height * 0.5;
    const bottomWy = cy + this.height * 0.5;
    const maxViewLat = this.clampLat(this.worldYToLat(topWy, ws)) + 2;
    const minViewLat = this.clampLat(this.worldYToLat(bottomWy, ws)) - 2;

    this.renderBorderRingSet(ctx, this.borderStateRings, 'rgba(226, 232, 240, 0.45)', 0.85, ws, cx, cy, minViewLat, maxViewLat);
    this.renderBorderRingSet(ctx, this.borderCountryRings, 'rgba(248, 250, 252, 0.78)', 1.2, ws, cx, cy, minViewLat, maxViewLat);
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;

    // 1. Neutral airy canvas background before/around slippy map tiles
    ctx.fillStyle = '#e5ecf2';
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. Render slippy tile canvas base (Satellite Orthophoto or OSM street map)
    const provider: TileProviderId = this.state.showLandOrtho() ? 'sat' : 'osm';
    const ws = this.worldSize();
    const cx = this.lonToWorldX(this.centerLon, ws);
    const cy = this.latToWorldY(this.centerLat, ws);

    const maxProviderZoom = provider === 'sat' ? SAT_MAX_ZOOM : 18;
    const tileZ = Math.max(Math.floor(MIN_ZOOM), Math.min(maxProviderZoom, Math.round(this.zoom)));
    const tilesCount = 1 << tileZ;
    const scale = Math.pow(2, this.zoom - tileZ);
    const tilePx = TILE_SIZE * scale;

    const topLeftWx = cx - this.width * 0.5;
    const topLeftWy = cy - this.height * 0.5;
    const scaleToTile = 1 / scale;

    const minTx = Math.floor((topLeftWx * scaleToTile) / TILE_SIZE);
    const maxTx = Math.floor(((topLeftWx + this.width) * scaleToTile) / TILE_SIZE);
    const minTy = Math.max(0, Math.floor((topLeftWy * scaleToTile) / TILE_SIZE));
    const maxTy = Math.min(tilesCount - 1, Math.floor(((topLeftWy + this.height) * scaleToTile) / TILE_SIZE));

    for (let ty = minTy; ty <= maxTy; ty++) {
      const dy = ty * tilePx - topLeftWy;
      for (let tx = minTx; tx <= maxTx; tx++) {
        const dx = tx * tilePx - topLeftWx;
        const wrappedX = ((tx % tilesCount) + tilesCount) % tilesCount;
        const tile = this.getOrFetchTile(provider, tileZ, wrappedX, ty);
        if (tile.status === 'ready' && tile.img.complete && tile.img.naturalWidth > 0) {
          ctx.drawImage(tile.img, dx, dy, tilePx + 0.5, tilePx + 0.5);
        } else {
          this.drawFallbackTile(ctx, provider, tileZ, wrappedX, ty, dx, dy, tilePx + 0.5);
        }
      }
    }

    // 2b. Conditional Administrative Borders overlay when Orthophoto is selected
    if (this.state.showLandOrtho() && this.state.showBorders()) {
      this.renderAdministrativeBorders(ctx, ws, cx, cy);
    }

    // 3. Render non-overlapping true-scale fire squares clipped cleanly to active region polygon
    this.renderHotspotSquares(ctx, ws, cx, cy);

    // 4. Render region polygon / draft / live draw preview + interactive editing handles
    this.renderRegionOverlay(ctx, ws, cx, cy);

    // 5. Render current user location pin when enabled
    this.renderUserLocationPin(ctx, ws, cx, cy);

    ctx.restore();

    // 6. Keep the glow overlay in step with the camera
    this.drawGlow(this.currentGlowLevel());
    this.startGlowLoop();
  }

  private currentGlowLevel(): number {
    return prefersReducedMotion() ? STATIC_GLOW_LEVEL : hotspotGlowLevel(performance.now() - this.glowStart);
  }

  /**
   * Animation loop of the glow overlay only (the basemap is not repainted). It skips frames
   * while the glow rests between pulses, runs at most ~30 fps, and stops when there is
   * nothing to glow or the user prefers reduced motion (a static glow is drawn instead).
   */
  private startGlowLoop(): void {
    if (this.glowRaf !== null) return;
    this.ngZone.runOutsideAngular(() => {
      const tick = (now: number) => {
        this.glowRaf = null;
        if (!this.glowCtx) return;
        if (!this.glowEdges.length || !this.state.showHotspotsOnGlobe() || prefersReducedMotion()) {
          this.drawGlow(this.currentGlowLevel());
          return;
        }
        const elapsed = now - this.glowStart;
        const resting = hotspotGlowIsResting(elapsed) && this.glowLastLevel >= 0;
        if (!resting && now - this.glowLastDraw >= 33) {
          this.drawGlow(hotspotGlowLevel(elapsed));
        }
        this.glowRaf = requestAnimationFrame(tick);
      };
      this.glowRaf = requestAnimationFrame(tick);
    });
  }

  private drawGlow(level: number): void {
    const g = this.glowCtx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    this.glowLastLevel = level;
    this.glowLastDraw = performance.now();
    const multi = this.state.regionMultiPolygon();
    if (!this.glowEdges.length || !this.state.showHotspotsOnGlobe() || multi.length === 0) return;

    const ws = this.worldSize();
    const cx = this.lonToWorldX(this.centerLon, ws);
    const cy = this.latToWorldY(this.centerLat, ws);
    g.save();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.beginPath();
    for (const poly of multi) this.tracePolygonPath(g, poly, ws, cx, cy);
    g.clip('evenodd');

    const path = new Path2D();
    let any = false;
    const pad = 24;
    for (const e of this.glowEdges) {
      const [x0, y0] = this.lonLatToScreen(e.lon0, e.lat0, ws, cx, cy);
      const [x1, y1] = this.lonLatToScreen(e.lon1, e.lat1, ws, cx, cy);
      if (Math.max(x0, x1) < -pad || Math.min(x0, x1) > this.width + pad) continue;
      if (Math.max(y0, y1) < -pad || Math.min(y0, y1) > this.height + pad) continue;
      path.moveTo(x0, y0);
      path.lineTo(x1, y1);
      any = true;
    }
    if (any) {
      // Zoomed out, a cell is only a few px wide: thin and soften the glow so it frames the
      // squares instead of repainting them red.
      const e0 = this.glowEdges[0];
      const [ax] = this.lonLatToScreen(0, 0, ws, cx, cy);
      const [bx] = this.lonLatToScreen(e0.wLon, 0, ws, cx, cy);
      const cellPx = Math.abs(bx - ax);
      const k = Math.max(0.3, Math.min(1, (cellPx - 1) / 6));
      const [r, gr, b] = hotspotGlowRgb(this.state.colorRamp());
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // soft halo
      g.shadowColor = `rgba(${r}, ${gr}, ${b}, ${Math.min(1, level + 0.1).toFixed(3)})`;
      g.shadowBlur = (4 + 14 * level) * k;
      g.strokeStyle = `rgba(${r}, ${gr}, ${b}, ${(0.55 * level * k).toFixed(3)})`;
      g.lineWidth = 1 + 2 * k;
      g.stroke(path);
      // crisp rim
      g.shadowBlur = 0;
      g.strokeStyle = `rgba(${r}, ${Math.min(255, gr + 50)}, ${Math.min(255, b + 30)}, ${(0.9 * level * k).toFixed(3)})`;
      g.lineWidth = 0.75 + 0.5 * k;
      g.stroke(path);
    }
    g.restore();
  }

  private renderUserLocationPin(
    ctx: CanvasRenderingContext2D,
    ws: number,
    cx: number,
    cy: number
  ): void {
    if (!this.state.showUserLocation()) return;
    const loc = this.state.userLocation();
    if (!loc) return;

    const [sx, sy] = this.lonLatToScreen(loc.lon, loc.lat, ws, cx, cy);
    if (sx < -40 || sx > this.width + 40 || sy < -40 || sy > this.height + 40) return;

    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.18)';
    ctx.fill();
    ctx.strokeStyle = USER_LOCATION_PIN_COLOR;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();

    drawUserLocationPin(ctx, sx, sy, 28);
  }

  private tracePolygonPath(
    ctx: CanvasRenderingContext2D,
    rings: PolygonCoords,
    ws: number,
    cx: number,
    cy: number
  ): void {
    for (const ring of rings) {
      if (ring.length < 3) continue;
      for (let i = 0; i < ring.length; i++) {
        const [sx, sy] = this.lonLatToScreen(ring[i][0], ring[i][1], ws, cx, cy);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
    }
  }

  private renderHotspotSquares(
    ctx: CanvasRenderingContext2D,
    ws: number,
    cx: number,
    cy: number
  ): void {
    if (!this.state.showHotspotsOnGlobe()) return;
    const squares = this.analytics.globePixelSquares();
    const multi = this.state.regionMultiPolygon();
    if (!squares.length || multi.length === 0) return;

    const rampId = this.state.colorRamp();
    const ordered = [...squares].sort((a, b) => a.normIntensity - b.normIntensity);

    ctx.save();
    ctx.beginPath();
    for (const poly of multi) {
      this.tracePolygonPath(ctx, poly, ws, cx, cy);
    }
    ctx.clip('evenodd');

    for (const sq of ordered) {
      const [x0, y0] = this.lonLatToScreen(sq.lon - sq.halfLon, sq.lat + sq.halfLat, ws, cx, cy);
      const [x1, y1] = this.lonLatToScreen(sq.lon + sq.halfLon, sq.lat - sq.halfLat, ws, cx, cy);
      const w = Math.max(2, x1 - x0);
      const h = Math.max(2, y1 - y0);
      if (x0 + w < 0 || x0 > this.width || y0 + h < 0 || y0 > this.height) continue;

      const [r, g, b] = this.ramps.sampleRgb(rampId, sq.normIntensity);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.84)`;
      ctx.fillRect(x0, y0, w, h);

      if (w >= 8 && h >= 8) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.lineWidth = 0.75;
        ctx.strokeRect(x0 + 0.375, y0 + 0.375, w - 0.75, h - 0.75);
      }
    }

    ctx.restore();
  }

  private getDisplayRings(): {
    multi: MultiPolygonCoords;
    isPreview: boolean;
    isDraft: boolean;
    editableOuter: PolygonRing | null;
  } {
    const live = this.state.liveDrawBbox();
    const draft = this.state.draftPolygon();
    const showBbox = this.state.showRegionBbox();
    if (!showBbox && live === null) {
      return { multi: [], isPreview: false, isDraft: false, editableOuter: null };
    }

    if (live) {
      const [w, s, e, n] = live;
      const boxRing: PolygonRing = [[w, s], [e, s], [e, n], [w, n], [w, s]];
      const base = this.state.drawBoxMode() === 'add' ? this.state.regionMultiPolygon() : [];
      return { multi: [...base, [boxRing]], isPreview: true, isDraft: false, editableOuter: null };
    }

    if (draft && draft.length >= 3) {
      return {
        multi: [ringToClosedPolygonCoords(draft)],
        isPreview: true,
        isDraft: true,
        editableOuter: draft
      };
    }

    const accepted = this.state.regionMultiPolygon();
    return { multi: accepted, isPreview: false, isDraft: false, editableOuter: this.getEditableAcceptedOuter(accepted) };
  }

  private getEditableAcceptedOuter(accepted = this.state.regionMultiPolygon()): PolygonRing | null {
    if (this.state.regionBorderMultiPolygon()) return null;
    if (accepted.length !== 1) return null;
    const outer = this.stripClosingVertex(accepted[0][0]);
    return outer.length >= 3 && outer.length <= 32 ? outer : null;
  }

  private getEditableActivePoly(): PolygonRing | null {
    if (!this.state.showRegionBbox()) return null;
    const draft = this.state.draftPolygon();
    if (draft && draft.length >= 3) return draft;
    return this.getEditableAcceptedOuter();
  }

  private stripClosingVertex(ring: PolygonRing): PolygonRing {
    if (ring.length > 1) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) {
        return ring.slice(0, -1);
      }
    }
    return ring;
  }

  private renderRegionOverlay(
    ctx: CanvasRenderingContext2D,
    ws: number,
    cx: number,
    cy: number
  ): void {
    const { multi, isPreview, isDraft, editableOuter } = this.getDisplayRings();
    if (multi.length === 0) return;

    const strokeColor = isPreview ? '#d97706' : '#d37400';
    const fillColor = isPreview ? 'rgba(217, 119, 6, 0.2)' : 'rgba(211, 116, 0, 0.13)';

    for (const poly of multi) {
      ctx.save();
      ctx.beginPath();
      this.tracePolygonPath(ctx, poly, ws, cx, cy);
      ctx.fillStyle = fillColor;
      ctx.fill('evenodd');

      if (isPreview && !isDraft) {
        ctx.setLineDash([7, 5]);
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = isPreview ? 2.4 : 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    if (editableOuter && editableOuter.length >= 3) {
      // Midpoint split cues (click any edge to split 4 -> 5 -> N vertices)
      for (let i = 0; i < editableOuter.length; i++) {
        const a = editableOuter[i];
        const b = editableOuter[(i + 1) % editableOuter.length];
        const [mx, my] = this.lonLatToScreen((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, ws, cx, cy);
        ctx.beginPath();
        ctx.arc(mx, my, 2.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Corner / vertex drag handles
      for (const pt of editableOuter) {
        const [vx, vy] = this.lonLatToScreen(pt[0], pt[1], ws, cx, cy);
        ctx.beginPath();
        ctx.arc(vx, vy, 4, 0, Math.PI * 2);
        ctx.fillStyle = strokeColor;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  private buildSortedBbox(a: [number, number], b: [number, number]): BoundingBox {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }

  private polyToScreenPts(poly: PolygonRing): ScreenPt[] {
    const ws = this.worldSize();
    const cx = this.lonToWorldX(this.centerLon, ws);
    const cy = this.latToWorldY(this.centerLat, ws);
    return poly.map(pt => this.lonLatToScreen(pt[0], pt[1], ws, cx, cy));
  }

  private findHitVertex(clientX: number, clientY: number, poly: PolygonRing): number {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    return findNearestVertexPx(clientX - rect.left, clientY - rect.top, this.polyToScreenPts(poly));
  }

  private findHitEdge(clientX: number, clientY: number, poly: PolygonRing): number {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    return findNearestEdgePx(clientX - rect.left, clientY - rect.top, this.polyToScreenPts(poly));
  }

  onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0 && ev.pointerType !== 'touch') return;
    const canvas = this.canvasRef.nativeElement;
    this.activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const wantsDraw = this.state.isDrawingBbox() || ev.shiftKey;

    if (this.activePointers.size >= 2 && !wantsDraw) {
      this.isPanning = false;
      this.draggingVertexIdx = null;
      const [p1, p2] = Array.from(this.activePointers.values());
      this.lastPinchMidX = (p1.x + p2.x) * 0.5;
      this.lastPinchMidY = (p1.y + p2.y) * 0.5;
      this.lastPinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      return;
    }

    const hitLonLat = this.screenToLonLat(ev.clientX, ev.clientY);

    if (wantsDraw) {
      this.isDraggingBbox = true;
      this.drawAnchorLonLat = hitLonLat;
      canvas.style.cursor = 'crosshair';
      this.ngZone.run(() => {
        if (this.drawAnchorLonLat) {
          this.state.liveDrawBbox.set(this.buildSortedBbox(this.drawAnchorLonLat, this.drawAnchorLonLat));
        }
      });
    } else {
      const activePoly = this.getEditableActivePoly();
      const vertexIdx = activePoly ? this.findHitVertex(ev.clientX, ev.clientY, activePoly) : -1;
      if (vertexIdx >= 0) {
        this.draggingVertexIdx = vertexIdx;
        canvas.style.cursor = 'grabbing';
        this.ngZone.run(() => this.state.updateDraftVertex(vertexIdx, hitLonLat));
      } else if (activePoly) {
        const edgeIdx = this.findHitEdge(ev.clientX, ev.clientY, activePoly);
        if (edgeIdx >= 0) {
          canvas.style.cursor = 'grabbing';
          this.ngZone.run(() => {
            const inserted = this.state.insertPolygonVertex(edgeIdx, hitLonLat);
            if (inserted !== null) {
              this.draggingVertexIdx = inserted;
            }
          });
        } else {
          this.startPan(ev);
        }
      } else {
        this.startPan(ev);
      }
    }

    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      // ignore if unsupported
    }
  }

  private startPan(ev: PointerEvent): void {
    this.isPanning = true;
    this.panLastClientX = ev.clientX;
    this.panLastClientY = ev.clientY;
    this.canvasRef.nativeElement.style.cursor = 'grabbing';
  }

  onPointerMove(ev: PointerEvent): void {
    const canvas = this.canvasRef.nativeElement;
    if (this.activePointers.has(ev.pointerId)) {
      this.activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }

    if (this.activePointers.size >= 2 && !this.isDraggingBbox) {
      const [p1, p2] = Array.from(this.activePointers.values());
      const midX = (p1.x + p2.x) * 0.5;
      const midY = (p1.y + p2.y) * 0.5;
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (this.lastPinchDist > 8 && dist > 8) {
        const rect = canvas.getBoundingClientRect();
        const prevSx = this.lastPinchMidX - rect.left;
        const prevSy = this.lastPinchMidY - rect.top;
        const nextSx = midX - rect.left;
        const nextSy = midY - rect.top;

        const wsBefore = this.worldSize();
        const anchorLon = this.worldXToLon(this.lonToWorldX(this.centerLon, wsBefore) + (prevSx - this.width * 0.5), wsBefore);
        const anchorLat = this.worldYToLat(this.latToWorldY(this.centerLat, wsBefore) + (prevSy - this.height * 0.5), wsBefore);

        const nextZoom = Math.max(
          this.effectiveMinZoom(),
          Math.min(MAX_ZOOM, this.zoom + Math.log2(dist / this.lastPinchDist))
        );
        this.zoom = nextZoom;

        const wsAfter = this.worldSize();
        this.setCameraCenterFromWorld(
          this.lonToWorldX(anchorLon, wsAfter) - (nextSx - this.width * 0.5),
          this.latToWorldY(anchorLat, wsAfter) - (nextSy - this.height * 0.5),
          wsAfter
        );
        this.syncZoomSignal();
        this.persistUserCamera();
        this.requestRender();
      }
      this.lastPinchMidX = midX;
      this.lastPinchMidY = midY;
      this.lastPinchDist = dist;
      return;
    }

    if (this.draggingVertexIdx !== null) {
      const curLonLat = this.screenToLonLat(ev.clientX, ev.clientY);
      const idx = this.draggingVertexIdx;
      this.ngZone.run(() => this.state.updateDraftVertex(idx, curLonLat));
      return;
    }

    if (this.isDraggingBbox && this.drawAnchorLonLat) {
      const curLonLat = this.screenToLonLat(ev.clientX, ev.clientY);
      const preview = this.buildSortedBbox(this.drawAnchorLonLat, curLonLat);
      this.ngZone.run(() => this.state.liveDrawBbox.set(preview));
      return;
    }

    if (this.isPanning) {
      const dx = ev.clientX - this.panLastClientX;
      const dy = ev.clientY - this.panLastClientY;
      this.panLastClientX = ev.clientX;
      this.panLastClientY = ev.clientY;

      const ws = this.worldSize();
      this.setCameraCenterFromWorld(
        this.lonToWorldX(this.centerLon, ws) - dx,
        this.latToWorldY(this.centerLat, ws) - dy,
        ws
      );
      if (Math.abs(dx) + Math.abs(dy) > 0) {
        this.persistUserCamera();
      }
      this.requestRender();
      return;
    }

    // Hover cursor feedback
    if (this.state.isDrawingBbox() || ev.shiftKey) {
      canvas.style.cursor = 'crosshair';
      return;
    }
    const activePoly = this.getEditableActivePoly();
    if (activePoly) {
      if (this.findHitVertex(ev.clientX, ev.clientY, activePoly) >= 0) {
        canvas.style.cursor = 'pointer';
        return;
      }
      if (this.findHitEdge(ev.clientX, ev.clientY, activePoly) >= 0) {
        canvas.style.cursor = 'cell';
        return;
      }
    }
    canvas.style.cursor = 'grab';
  }

  onPointerUp(ev: PointerEvent): void {
    const canvas = this.canvasRef.nativeElement;
    this.activePointers.delete(ev.pointerId);
    if (this.activePointers.size < 2) {
      this.lastPinchDist = 0;
      if (this.activePointers.size === 1) {
        const [rem] = Array.from(this.activePointers.values());
        this.panLastClientX = rem.x;
        this.panLastClientY = rem.y;
      }
    }
    if (this.draggingVertexIdx !== null) {
      this.draggingVertexIdx = null;
      canvas.style.cursor = 'grab';
      this.releaseCapture(canvas, ev.pointerId);
      return;
    }

    if (this.isDraggingBbox) {
      const anchor = this.drawAnchorLonLat;
      this.isDraggingBbox = false;
      this.drawAnchorLonLat = null;
      canvas.style.cursor = this.state.isDrawingBbox() ? 'crosshair' : 'grab';
      this.releaseCapture(canvas, ev.pointerId);

      const endLonLat = this.screenToLonLat(ev.clientX, ev.clientY);
      const live = this.state.liveDrawBbox();
      this.ngZone.run(() => {
        if (anchor) {
          this.state.finishDrawBoundingBox(this.buildSortedBbox(anchor, endLonLat));
        } else if (live) {
          this.state.finishDrawBoundingBox(live);
        } else {
          this.state.cancelDrawBoundingBox();
        }
      });
      return;
    }

    if (this.isPanning) {
      this.isPanning = false;
      canvas.style.cursor = 'grab';
      this.releaseCapture(canvas, ev.pointerId);
      this.ngZone.run(() => this.state.cameraTargetLonLat.set([this.centerLon, this.centerLat]));
    }
  }

  onPointerLeave(): void {
    if (!this.isPanning && !this.isDraggingBbox && this.draggingVertexIdx === null) {
      this.canvasRef.nativeElement.style.cursor = this.state.isDrawingBbox() ? 'crosshair' : 'grab';
    }
  }

  private releaseCapture(canvas: HTMLCanvasElement, pointerId: number): void {
    try {
      canvas.releasePointerCapture(pointerId);
    } catch {
      // ignore
    }
  }

  private readonly onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;

    // Anchor the coordinate under the cursor so zoom focuses directly at pointer
    const wsBefore = this.worldSize();
    const wxAnchor = this.lonToWorldX(this.centerLon, wsBefore) + (sx - this.width * 0.5);
    const wyAnchor = this.latToWorldY(this.centerLat, wsBefore) + (sy - this.height * 0.5);
    const anchorLon = this.worldXToLon(wxAnchor, wsBefore);
    const anchorLat = this.worldYToLat(wyAnchor, wsBefore);

    const nextZoom = Math.max(this.effectiveMinZoom(), Math.min(MAX_ZOOM, this.zoom - ev.deltaY * 0.0022));
    if (Math.abs(nextZoom - this.zoom) < 1e-4) return;
    this.zoom = nextZoom;

    const wsAfter = this.worldSize();
    this.setCameraCenterFromWorld(
      this.lonToWorldX(anchorLon, wsAfter) - (sx - this.width * 0.5),
      this.latToWorldY(anchorLat, wsAfter) - (sy - this.height * 0.5),
      wsAfter
    );

    this.syncZoomSignal();
    this.persistUserCamera();
    this.requestRender();
  };
}
