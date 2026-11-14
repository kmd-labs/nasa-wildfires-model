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
import { I18nService } from '../../core/i18n/i18n.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { WildfireStateService, ringToClosedPolygonCoords } from '../../core/services/wildfire-state.service';
import { HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';
import { ColorRampService } from '../../core/services/color-ramp.service';
import { GlobeTileService } from '../../core/services/globe-tile.service';
import { BoundingBox, MultiPolygonCoords, PolygonCoords, PolygonRing } from '../../core/models/wildfire.model';
import { ScreenPt, findNearestEdgePx, findNearestVertexPx } from '../../core/utils/polygon-clip';

interface CachedTile {
  status: 'loading' | 'ready' | 'error';
  img: HTMLImageElement;
  lastUsed: number;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 17.5;
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

  readonly i18n = inject(I18nService);
  private readonly ngZone = inject(NgZone);
  private readonly hostRef = inject(ElementRef<HTMLElement>);
  private readonly data = inject(WildfireDataService);
  private readonly state = inject(WildfireStateService);
  private readonly analytics = inject(HotspotAnalyticsService);
  private readonly ramps = inject(ColorRampService);
  private readonly tiles = inject(GlobeTileService);

  private ctx: CanvasRenderingContext2D | null = null;
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

  // Tile cache
  private readonly tileCache = new Map<string, CachedTile>();

  // Pointer interaction state
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
      untracked(() => this.requestRender());
    });

    let focusInitialized = false;
    effect(() => {
      const focus = this.state.cameraFocus();
      if (!focusInitialized) {
        focusInitialized = true;
        return;
      }
      untracked(() => {
        if (focus === 'iberia') {
          const bbox = this.state.regionBbox();
          if (bbox) {
            this.fitBboxToViewport(bbox);
          } else {
            this.centerLon = -5.5;
            this.centerLat = 40.3;
            this.zoom = 6;
          }
        } else if (focus === 'northAtlantic') {
          this.centerLon = -48;
          this.centerLat = 35;
          this.zoom = 4;
        } else {
          this.centerLon = -140;
          this.centerLat = 0;
          this.zoom = 3.2;
        }
        this.syncZoomSignal();
        this.requestRender();
      });
    });

    effect(() => {
      const trigger = this.state.flyToBboxTrigger();
      if (trigger > 0) {
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
    this.updateCanvasSize();

    const initialBbox = this.state.regionBbox();
    if (initialBbox) {
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
  }

  private readonly onResize = () => {
    this.updateCanvasSize();
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

  private fitBboxToViewport(bbox: BoundingBox): void {
    const [w, s, e, n] = bbox;
    // Offset slightly right of the left analytics panel on desktop so AOI is cleanly visible
    const leftReserve = this.width > 960 && !this.state.isAnalyticsMinimized() ? 360 : 32;
    const rightReserve = 40;
    const topReserve = 80;
    const bottomReserve = 48;
    const availW = Math.max(160, this.width - leftReserve - rightReserve);
    const availH = Math.max(160, this.height - topReserve - bottomReserve);

    const ws1 = TILE_SIZE;
    const spanX = Math.max(1e-5, (e - w) / 360) * ws1;
    const spanY = Math.max(1e-5, this.latToWorldY(s, ws1) - this.latToWorldY(n, ws1));
    const zoomX = Math.log2((availW * 0.72) / spanX);
    const zoomY = Math.log2((availH * 0.72) / spanY);
    this.zoom = Math.max(MIN_ZOOM, Math.min(13.5, Math.min(zoomX, zoomY)));

    const ws = this.worldSize();
    const bboxMidWx = this.lonToWorldX((w + e) * 0.5, ws);
    const bboxMidWy = (this.latToWorldY(s, ws) + this.latToWorldY(n, ws)) * 0.5;
    const desiredScreenX = leftReserve + availW * 0.5;
    const desiredScreenY = topReserve + availH * 0.5;
    const shiftedCx = bboxMidWx - (desiredScreenX - this.width * 0.5);
    const shiftedCy = bboxMidWy - (desiredScreenY - this.height * 0.5);

    this.centerLon = this.wrapLon(this.worldXToLon(shiftedCx, ws));
    this.centerLat = this.clampLat(this.worldYToLat(shiftedCy, ws));
    this.syncZoomSignal();
  }

  private syncZoomSignal(): void {
    const zInt = Math.max(MIN_ZOOM, Math.min(18, Math.round(this.zoom)));
    if (zInt !== this.lastReportedTileZoom) {
      this.lastReportedTileZoom = zInt;
      this.ngZone.run(() => this.state.activeTileZoom.set(zInt));
    }
  }

  private getOrFetchTile(z: number, x: number, y: number): CachedTile {
    const key = `${z}/${x}/${y}`;
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
    img.src = this.tiles.buildTileUrl('osm', z, x, y);
    return record;
  }

  private drawFallbackTile(
    ctx: CanvasRenderingContext2D,
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
      const ancestor = this.tileCache.get(`${pz}/${px}/${py}`);
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

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;

    // 1. Neutral airy canvas background before/around OSM tiles
    ctx.fillStyle = '#e5ecf2';
    ctx.fillRect(0, 0, this.width, this.height);

    // 2. Render OSM slippy tile canvas base
    const ws = this.worldSize();
    const cx = this.lonToWorldX(this.centerLon, ws);
    const cy = this.latToWorldY(this.centerLat, ws);

    const tileZ = Math.max(MIN_ZOOM, Math.min(18, Math.round(this.zoom)));
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
        const tile = this.getOrFetchTile(tileZ, wrappedX, ty);
        if (tile.status === 'ready' && tile.img.complete && tile.img.naturalWidth > 0) {
          ctx.drawImage(tile.img, dx, dy, tilePx + 0.5, tilePx + 0.5);
        } else {
          this.drawFallbackTile(ctx, tileZ, wrappedX, ty, dx, dy, tilePx + 0.5);
        }
      }
    }

    // 3. Render non-overlapping true-scale fire squares clipped cleanly to active region polygon
    this.renderHotspotSquares(ctx, ws, cx, cy);

    // 4. Render region polygon / draft / live draw preview + interactive editing handles
    this.renderRegionOverlay(ctx, ws, cx, cy);

    ctx.restore();
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
    const regionPoly = this.state.regionPolygon();
    if (!squares.length || !regionPoly || regionPoly.length < 3) return;

    const rampId = this.state.colorRamp();
    const ordered = [...squares].sort((a, b) => a.normIntensity - b.normIntensity);

    ctx.save();
    ctx.beginPath();
    this.tracePolygonPath(ctx, ringToClosedPolygonCoords(regionPoly), ws, cx, cy);
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
    if (!showBbox && live === null && draft === null) {
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
    const outer = accepted.length === 1 ? this.stripClosingVertex(accepted[0][0]) : null;
    return { multi: accepted, isPreview: false, isDraft: false, editableOuter: outer };
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
    const hitLonLat = this.screenToLonLat(ev.clientX, ev.clientY);
    const wantsDraw = this.state.isDrawingBbox() || ev.shiftKey;

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
      const activePoly = this.state.draftPolygon() ?? this.state.regionPolygon();
      const vertexIdx = activePoly && activePoly.length >= 3 ? this.findHitVertex(ev.clientX, ev.clientY, activePoly) : -1;
      if (vertexIdx >= 0) {
        this.draggingVertexIdx = vertexIdx;
        canvas.style.cursor = 'grabbing';
        this.ngZone.run(() => this.state.updateDraftVertex(vertexIdx, hitLonLat));
      } else if (activePoly && activePoly.length >= 3) {
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
      const newCx = this.lonToWorldX(this.centerLon, ws) - dx;
      const newCy = this.latToWorldY(this.centerLat, ws) - dy;
      this.centerLon = this.wrapLon(this.worldXToLon(newCx, ws));
      this.centerLat = this.clampLat(this.worldYToLat(newCy, ws));
      this.requestRender();
      return;
    }

    // Hover cursor feedback
    if (this.state.isDrawingBbox() || ev.shiftKey) {
      canvas.style.cursor = 'crosshair';
      return;
    }
    const activePoly = this.state.draftPolygon() ?? this.state.regionPolygon();
    if (activePoly && activePoly.length >= 3) {
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

    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom - ev.deltaY * 0.0022));
    if (Math.abs(nextZoom - this.zoom) < 1e-4) return;
    this.zoom = nextZoom;

    const wsAfter = this.worldSize();
    const cxAfter = this.lonToWorldX(anchorLon, wsAfter) - (sx - this.width * 0.5);
    const cyAfter = this.latToWorldY(anchorLat, wsAfter) - (sy - this.height * 0.5);
    this.centerLon = this.wrapLon(this.worldXToLon(cxAfter, wsAfter));
    this.centerLat = this.clampLat(this.worldYToLat(cyAfter, wsAfter));

    this.syncZoomSignal();
    this.requestRender();
  };
}
