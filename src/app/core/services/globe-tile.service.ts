import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { GlobeMathService } from './globe-math.service';

export type TileProviderId = 'sat' | 'osm';

interface CachedTile {
  key: string;
  provider: TileProviderId;
  z: number;
  x: number;
  y: number;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  tex: THREE.Texture;
  loaded: boolean;
  lastUsed: number;
}

@Injectable({
  providedIn: 'root'
})
export class GlobeTileService {
  private readonly math = inject(GlobeMathService);
  private readonly loader = new THREE.TextureLoader();

  private readonly MAX_CACHE = 110;
  private readonly cache = new Map<string, CachedTile>();
  private accessTick = 0;

  constructor() {
    this.loader.setCrossOrigin('anonymous');
  }

  /**
   * Computes an appropriate Web Mercator slippy-map zoom level for the current
   * camera altitude, field of view, viewport height, and center latitude.
   */
  computeOptimalZoom(
    cameraDist: number,
    fovDeg: number,
    viewportHeight: number,
    centerLatDeg: number,
    minZ = 2,
    maxZ = 16
  ): number {
    const R = this.math.R;
    const alt = Math.max(0.015, cameraDist - R);
    const fovRad = (fovDeg * Math.PI) / 180;
    const spanRad = Math.min(Math.PI, (2 * alt * Math.tan(fovRad * 0.5)) / R);
    const cosLat = Math.max(0.25, Math.cos((this.math.clamp(centerLatDeg, -82, 82) * Math.PI) / 180));
    const pixelsPerEquator = Math.max(256, viewportHeight) * ((2 * Math.PI) / spanRad) * cosLat;
    const zFloat = Math.log2(pixelsPerEquator / 256);
    return Math.round(this.math.clamp(zFloat, minZ, maxZ));
  }

  /**
   * Updates visible tiles in the given layer group cleanly with LRU caching.
   */
  syncLayerTiles(params: {
    group: THREE.Group;
    provider: TileProviderId;
    enabled: boolean;
    z: number;
    centerLon: number;
    centerLat: number;
    baseRadiusFactor: number;
    renderOrderBase: number;
  }) {
    const { group, provider, enabled, z, centerLon, centerLat, baseRadiusFactor, renderOrderBase } = params;

    if (!enabled) {
      group.visible = false;
      return;
    }
    group.visible = true;

    const n = 1 << z;
    const { tx: centerX, ty: centerY } = this.lonLatToTile(centerLon, centerLat, z);
    const radiusX = z <= 3 ? 3 : 2;
    const radiusY = 2;

    const wantedKeys = new Set<string>();
    const wantedCoords: Array<{ x: number; y: number; key: string }> = [];

    for (let dy = -radiusY; dy <= radiusY; dy++) {
      const y = centerY + dy;
      if (y < 0 || y >= n) continue;
      for (let dx = -radiusX; dx <= radiusX; dx++) {
        const wrappedX = ((centerX + dx) % n + n) % n;
        const key = `${provider}:${z}:${wrappedX}:${y}`;
        if (wantedKeys.has(key)) continue;
        wantedKeys.add(key);
        wantedCoords.push({ x: wrappedX, y, key });
      }
    }

    // Request/promote wanted tiles
    let allWantedLoaded = true;
    const nowTick = ++this.accessTick;
    for (const { x, y, key } of wantedCoords) {
      let entry = this.cache.get(key);
      if (!entry) {
        entry = this.createTileEntry(provider, z, x, y, key, baseRadiusFactor, renderOrderBase);
        this.cache.set(key, entry);
      }
      entry.lastUsed = nowTick;
      if (!entry.loaded) {
        allWantedLoaded = false;
      }
      if (entry.loaded && entry.mesh.parent !== group) {
        group.add(entry.mesh);
      }
    }

    // Keep fallback parent-level cached tiles visible underneath while finer tiles stream in
    for (const child of [...group.children]) {
      const key = child.userData?.['tileKey'] as string | undefined;
      if (!key) continue;
      if (wantedKeys.has(key)) continue;
      const cached = this.cache.get(key);
      const keepFallback = !allWantedLoaded && cached && cached.loaded && Math.abs(cached.z - z) <= 2;
      if (!keepFallback) {
        group.remove(child);
      }
    }

    this.evictOldTiles();
  }

  disposeAll() {
    for (const entry of this.cache.values()) {
      entry.mesh.parent?.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      entry.tex.dispose();
    }
    this.cache.clear();
  }

  private lonLatToTile(lonDeg: number, latDeg: number, z: number): { tx: number; ty: number } {
    const n = 1 << z;
    const clampedLat = this.math.clamp(latDeg, -85.0511, 85.0511);
    const latRad = (clampedLat * Math.PI) / 180;
    const tx = Math.floor(((lonDeg + 180) / 360) * n);
    const ty = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return {
      tx: ((tx % n) + n) % n,
      ty: Math.max(0, Math.min(n - 1, ty))
    };
  }

  private buildTileUrl(provider: TileProviderId, z: number, x: number, y: number): string {
    if (provider === 'osm') {
      return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    }
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  }

  private createTileEntry(
    provider: TileProviderId,
    z: number,
    x: number,
    y: number,
    key: string,
    baseRadiusFactor: number,
    renderOrderBase: number
  ): CachedTile {
    const n = 1 << z;
    const lonW = (x / n) * 360 - 180;
    const lonE = ((x + 1) / n) * 360 - 180;
    const mercTop = Math.PI * (1 - (2 * y) / n);
    const mercBot = Math.PI * (1 - (2 * (y + 1)) / n);

    // Slight radial & renderOrder step per zoom avoids Z-fighting between parent & child tiles
    const radius = this.math.R * (baseRadiusFactor + z * 0.000004);
    const segs = z <= 4 ? 10 : z <= 7 ? 6 : 3;
    const geo = this.createMercatorSphericalPatch(lonW, lonE, mercBot, mercTop, radius, segs);

    const url = this.buildTileUrl(provider, z, x, y);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = renderOrderBase + z;
    mesh.userData['tileKey'] = key;

    const entry: CachedTile = {
      key,
      provider,
      z,
      x,
      y,
      mesh,
      tex: new THREE.Texture(),
      loaded: false,
      lastUsed: this.accessTick
    };

    const tex = this.loader.load(
      url,
      (loadedTex) => {
        loadedTex.colorSpace = THREE.SRGBColorSpace;
        loadedTex.minFilter = THREE.LinearFilter;
        loadedTex.magFilter = THREE.LinearFilter;
        loadedTex.generateMipmaps = false;
        loadedTex.wrapS = THREE.ClampToEdgeWrapping;
        loadedTex.wrapT = THREE.ClampToEdgeWrapping;
        entry.tex.dispose();
        entry.tex = loadedTex;
        mat.map = loadedTex;
        mat.opacity = 1;
        mat.needsUpdate = true;
        entry.loaded = true;
      },
      undefined,
      () => {
        // Leave unloaded on transient error; LRU will clean up naturally
        entry.loaded = false;
      }
    );
    entry.tex = tex;

    return entry;
  }

  private createMercatorSphericalPatch(
    lonW: number,
    lonE: number,
    mercBot: number,
    mercTop: number,
    radius: number,
    segs: number
  ): THREE.BufferGeometry {
    const vertsPerRow = segs + 1;
    const positions = new Float32Array(vertsPerRow * vertsPerRow * 3);
    const uvs = new Float32Array(vertsPerRow * vertsPerRow * 2);
    const indices: number[] = [];
    const tmp = new THREE.Vector3();

    let pIdx = 0;
    let uvIdx = 0;
    for (let iy = 0; iy <= segs; iy++) {
      const v = iy / segs;
      const merc = mercBot + v * (mercTop - mercBot);
      const latDeg = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
      for (let ix = 0; ix <= segs; ix++) {
        const u = ix / segs;
        const lonDeg = lonW + u * (lonE - lonW);
        this.math.pos(lonDeg, latDeg, radius, tmp);
        positions[pIdx++] = tmp.x;
        positions[pIdx++] = tmp.y;
        positions[pIdx++] = tmp.z;
        uvs[uvIdx++] = u;
        uvs[uvIdx++] = v;
      }
    }

    for (let iy = 0; iy < segs; iy++) {
      for (let ix = 0; ix < segs; ix++) {
        const a = iy * vertsPerRow + ix;
        const b = a + 1;
        const c = a + vertsPerRow;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  private evictOldTiles() {
    if (this.cache.size <= this.MAX_CACHE) return;
    const sorted = [...this.cache.values()]
      .filter(entry => entry.mesh.parent === null)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const entry of sorted) {
      if (this.cache.size <= this.MAX_CACHE) break;
      this.cache.delete(entry.key);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      entry.tex.dispose();
    }
  }
}
