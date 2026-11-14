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
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as d3Geo from 'd3-geo';
import * as topojson from 'topojson-client';
import { BreakpointService } from '@kmd/design-system';
import { ThemeService } from '@kmd/design-system/services/theme.service';
import { isAtMost, isMobileLandscape } from '@kmd/design-system/utils/breakpoints';
import { GlobeMathService } from '../../core/services/globe-math.service';
import { SstDataService } from '../../core/services/sst-data.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { WildfireStateService } from '../../core/services/wildfire-state.service';
import { ColorRampService } from '../../core/services/color-ramp.service';
import { HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';
import { GlobeTileService } from '../../core/services/globe-tile.service';
import { BoundingBox } from '../../core/models/wildfire.model';

interface WindStreak {
  lon: number;
  lat: number;
  age: number;
  maxAge: number;
  hist: number[]; // flat [x, y, z, ...]
}

@Component({
  selector: 'app-globe',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './globe.component.html',
  styleUrl: './globe.component.scss'
})
export class GlobeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvasRef') canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly math = inject(GlobeMathService);
  readonly sstData = inject(SstDataService);
  readonly theme = inject(ThemeService);
  private readonly tiles = inject(GlobeTileService);
  readonly bp = inject(BreakpointService);
  readonly ramps = inject(ColorRampService);
  readonly analytics = inject(HotspotAnalyticsService);
  private readonly ngZone = inject(NgZone);

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;

  private globeMesh?: THREE.Mesh;
  private globeOrthoMat?: THREE.ShaderMaterial;
  private globeSstMat?: THREE.MeshLambertMaterial;
  private sstTex!: THREE.DataTexture;
  private orthoGlobalTex?: THREE.Texture;
  private orthoIberiaTex?: THREE.Texture;
  private forestTex?: THREE.Texture;
  private texData!: Uint8Array;
  private readonly GW = 720;
  private readonly GH = 360;
  private readonly NG = 720 * 360;

  private loadedLandFeature: any = null;
  private landMask: Uint8Array | null = null;

  // Wildfire view groups (vector layers, spread cells, evacuation zones, escape roads, bbox, hotspots)
  private readonly vectorGroup = new THREE.Group();
  private readonly graticuleGroup = new THREE.Group();
  private readonly landOrthoGroup = new THREE.Group();
  private readonly satTileGroup = new THREE.Group();
  private readonly forestGroup = new THREE.Group();
  private readonly osmTileGroup = new THREE.Group();
  private readonly urbanGroup = new THREE.Group();
  private readonly bordersGroup = new THREE.Group();
  private readonly roadGroup = new THREE.Group();
  private lastTileSyncTime = 0;
  private lastTileZoom = -1;
  private lastTileKey = '';
  private readonly spreadGroup = new THREE.Group();
  private readonly evacuationGroup = new THREE.Group();
  private readonly escapeRoadGroup = new THREE.Group();
  private readonly bboxGroup = new THREE.Group();
  private readonly hotspotGroup = new THREE.Group();

  // Interactive BBox drawing state
  private isDraggingBbox = false;
  private drawAnchorLonLat: [number, number] | null = null;

  // Animated wind streamlines over Iberia (Windy-style trails)
  private readonly WIND_COUNT = 220;
  private readonly WIND_TRAIL = 8;
  private windStreaks: WindStreak[] = [];
  private windGeo?: THREE.BufferGeometry;
  private windLines?: THREE.LineSegments;

  // Camera fly-to animation
  private camAnimStart = 0;
  private camAnimDuration = 1600;
  private isCamAnimating = false;
  private readonly camStartPos = new THREE.Vector3();
  private readonly camTargetPos = new THREE.Vector3();

  // 1:1 Surface-Grabbing & Raycasting
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouseVec = new THREE.Vector2();
  private readonly grabSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 10);
  private readonly grabHit = new THREE.Vector3();
  private readonly grabCur = new THREE.Vector3();
  private readonly grabQuat = new THREE.Quaternion();
  private grabDir: THREE.Vector3 | null = null;
  private isDraggingGlobe = false;

  private animId: number | null = null;
  private lastTime = 0;
  private lastRecolorMonth = -999;
  private lastRecolorMode = '';
  private canvasWidth = 1;
  private canvasHeight = 1;

  private readonly pv = new THREE.Vector3();

  constructor() {
    // React to SST month or display mode ('ortho' | 'sst' | 'anomaly') changes
    effect(() => {
      const m = this.state.sstMonth();
      const mode = this.state.sstMode();
      if (this.globeMesh && this.globeOrthoMat && this.globeSstMat) {
        const targetMat = mode === 'ortho' ? this.globeOrthoMat : this.globeSstMat;
        if (this.globeMesh.material !== targetMat) {
          this.globeMesh.material = targetMat;
        }
      }
      if (mode !== 'ortho' && this.texData && this.sstData.isLoaded()) {
        const thermalMode = mode === 'anomaly' ? 'anomaly' : 'sst';
        untracked(() => this.recolorSstTexture(m, thermalMode));
      }
    });

    // React to view mode or camera focus preset changes
    effect(() => {
      const focus = this.state.cameraFocus();
      const view = this.state.viewMode();
      if (this.camera) {
        const [lon, lat] = untracked(() => this.state.bboxCenter());
        untracked(() => this.flyToFocus(focus, view, lon, lat));
      }
    });

    // React to explicit fly-to-bbox requests
    effect(() => {
      const trigger = this.state.flyToBboxTrigger();
      if (trigger > 0 && this.camera) {
        untracked(() => this.flyToBbox(this.state.regionBbox()));
      }
    });

    // React to region BBox or live draw preview changes
    effect(() => {
      const live = this.state.liveDrawBbox();
      const bbox = live ?? this.state.regionBbox();
      const showBbox = this.state.showRegionBbox();
      if (this.scene) {
        untracked(() => {
          this.bboxGroup.visible = showBbox || live !== null;
          this.rebuildRegionBbox(bbox, live !== null);
        });
      }
    });

    // React to vector / cartographic globe layer visibility toggles
    effect(() => {
      this.graticuleGroup.visible = this.state.showGraticule();
      this.landOrthoGroup.visible = this.state.showLandOrtho();
      this.satTileGroup.visible = this.state.showLandOrtho() && this.state.sstMode() === 'ortho';
      this.forestGroup.visible = this.state.showForests();
      this.osmTileGroup.visible = this.state.showOsmTiles();
      this.urbanGroup.visible = this.state.showUrbanAreas();
      this.bordersGroup.visible = this.state.showBorders();
      this.roadGroup.visible = this.state.showRoads();
      if (this.camera) {
        untracked(() => this.syncSlippyTiles(true));
      }
    });

    // React to filtered harmonized hotspots, color ramp, and globe visibility toggle
    effect(() => {
      const hotspots = this.analytics.filteredHotspots();
      const ramp = this.state.colorRamp();
      const show = this.state.showHotspotsOnGlobe();
      const view = this.state.viewMode();
      if (this.scene) {
        untracked(() => {
          this.hotspotGroup.visible = show && view !== 'spread';
          this.rebuildGlobeHotspots(hotspots, ramp);
        });
      }
    });

    // React to wildfire data / state changes to rebuild 3D layers
    effect(() => {
      const view = this.state.viewMode();
      const loaded = this.data.isLoaded();
      const frameIdx = this.state.frameIndex();
      const scenario = this.state.windScenario();
      const showWind = this.state.showWindStreamlines();
      const showRoads = this.state.showEscapeRoads();

      if (!this.scene || !loaded) return;

      untracked(() => {
        this.spreadGroup.visible = view === 'spread';
        if (this.windLines) {
          this.windLines.visible = showWind;
        }
        this.evacuationGroup.visible = view === 'evacuation';
        this.escapeRoadGroup.visible = showRoads;

        this.rebuildSpreadCells(frameIdx, scenario);
        this.rebuildEvacuationZones(frameIdx, scenario);
      });
    });
  }

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      this.initThree();
      this.initSstData();
      this.initLandOverlay();
      this.initWildfireGroups();
      this.initWindStreamlines();

      window.addEventListener('resize', this.onResize);
      this.animate(0);

      this.sstData.loadData().then(() => {
        const m = this.state.sstMode();
        this.recolorSstTexture(this.state.sstMonth(), m === 'anomaly' ? 'anomaly' : 'sst');
      });

      this.data.loadAll().then(() => {
        this.rebuildEscapeRoads();
        this.rebuildSpreadCells(this.state.frameIndex(), this.state.windScenario());
        this.rebuildEvacuationZones(this.state.frameIndex(), this.state.windScenario());
        this.rebuildRegionBbox(this.state.regionBbox(), false);
        this.rebuildGlobeHotspots(this.analytics.filteredHotspots(), this.state.colorRamp());
      });
    });
  }

  ngOnDestroy() {
    if (this.animId !== null) cancelAnimationFrame(this.animId);
    window.removeEventListener('resize', this.onResize);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.sstTex?.dispose();
    this.orthoGlobalTex?.dispose();
    this.orthoIberiaTex?.dispose();
    this.forestTex?.dispose();
    this.globeOrthoMat?.dispose();
    this.globeSstMat?.dispose();
    this.tiles.disposeAll();
  }

  private readonly onResize = () => this.handleResize();

  private initThree() {
    const canvas = this.canvasRef.nativeElement;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.canvasWidth = canvas.clientWidth || window.innerWidth;
    this.canvasHeight = canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.canvasWidth, this.canvasHeight, false);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.theme.getTokenColor('globe-bg', '#f5f7fb'));

    this.camera = new THREE.PerspectiveCamera(
      40,
      this.canvasWidth / (this.canvasHeight || 1),
      0.5,
      160
    );

    const isLand = isMobileLandscape();
    const portrait = !isLand && (this.canvasWidth / (this.canvasHeight || 1) < 0.95 || isAtMost('mobile'));
    const initialDist = portrait ? 24 : isLand ? 16.5 : 18.5;
    const [iberiaLon, iberiaLat] = this.state.bboxCenter();

    // Start directly on the Iberian Peninsula
    this.math.pos(iberiaLon, iberiaLat, initialDist, this.camTargetPos);
    this.math.pos(iberiaLon - 6.0, iberiaLat + 3.0, initialDist * 1.15, this.camStartPos);

    this.camera.position.copy(this.camStartPos);
    this.isCamAnimating = true;
    this.camAnimStart = performance.now();

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.enableRotate = false; // Handled by 1:1 surface-grabbing
    this.controls.zoomSpeed = 0.45;
    this.controls.minDistance = 10.025;
    this.controls.maxDistance = 58.0;
    this.controls.enablePan = false;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.grabSphere.radius = this.math.R;

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xdbe4f0, 1.3);
    this.scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 8);
    this.scene.add(dirLight);

    this.initGlowAndBokeh();
  }

  private flyToFocus(focus: string, view: string, aoiLon: number, aoiLat: number) {
    if (!this.camera || !this.controls) return;
    const isLand = isMobileLandscape();
    const portrait = !isLand && (this.canvasWidth / (this.canvasHeight || 1) < 0.95 || isAtMost('mobile'));
    const scale = portrait ? 1.2 : isLand ? 0.9 : 1.0;

    let lon = aoiLon;
    let lat = aoiLat;
    let dist = 20.5 * scale;

    if (focus === 'iberia') {
      if (view === 'spread' || view === 'evacuation') {
        dist = 15.2 * scale;
      }
    } else if (focus === 'northAtlantic') {
      lon = -35.0;
      lat = 39.0;
      dist = 28.0 * scale;
    } else if (focus === 'pacificEnso') {
      lon = -140.0;
      lat = 2.0;
      dist = 31.0 * scale;
    }

    this.camStartPos.copy(this.camera.position);
    this.math.pos(lon, lat, dist, this.camTargetPos);
    this.camAnimDuration = 1100;
    this.camAnimStart = performance.now();
    this.isCamAnimating = true;
  }

  private flyToBbox(bbox: BoundingBox) {
    if (!this.camera || !this.controls) return;
    const [w, s, e, n] = bbox;
    const centerLon = (w + e) / 2;
    const centerLat = (s + n) / 2;
    const spanDeg = Math.max(Math.abs(e - w), Math.abs(n - s));

    const isLand = isMobileLandscape();
    const portrait = !isLand && (this.canvasWidth / (this.canvasHeight || 1) < 0.95 || isAtMost('mobile'));
    const scale = portrait ? 1.18 : isLand ? 0.9 : 1.0;

    // Map angular span onto smooth camera distance (clamped within OrbitControls bounds)
    const targetDist = this.math.clamp((10.25 + spanDeg * 0.55) * scale, 10.18, 38.0);

    this.camStartPos.copy(this.camera.position);
    this.math.pos(centerLon, centerLat, targetDist, this.camTargetPos);
    this.camAnimDuration = 950;
    this.camAnimStart = performance.now();
    this.isCamAnimating = true;
  }

  private initGlowAndBokeh() {
    const R = this.math.R;
    const glowMat = new THREE.ShaderMaterial({
      uniforms: {
        c: { value: new THREE.Color(this.theme.getTokenColor('globe-glow', '#0f172a')) },
        uOpacity: { value: 0.22 },
        uPower: { value: 2.2 }
      },
      vertexShader: `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 c;
        uniform float uOpacity;
        uniform float uPower;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float d = clamp(-dot(vN, vV), 0.0, 1.0);
          float t = clamp(d / 0.4938, 0.0, 1.0);
          float a = pow(t, uPower) * uOpacity;
          gl_FragColor = vec4(c, a);
        }
      `,
      side: THREE.BackSide,
      blending: THREE.NormalBlending,
      transparent: true,
      depthWrite: false
    });

    const haloMesh = new THREE.Mesh(new THREE.SphereGeometry(R * 1.15, 64, 32), glowMat);
    this.scene.add(haloMesh);

    const pGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(120 * 3);
    for (let i = 0; i < 120; i++) {
      const r = 35 + Math.random() * 60;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pMat = new THREE.PointsMaterial({
      color: new THREE.Color(this.theme.getTokenColor('globe-bokeh', '#94a3b8')),
      size: 0.45,
      transparent: true,
      opacity: 0.35
    });
    this.scene.add(new THREE.Points(pGeo, pMat));
  }

  private initSstData() {
    this.texData = new Uint8Array(this.NG * 4);
    this.sstTex = new THREE.DataTexture(this.texData, this.GW, this.GH, THREE.RGBAFormat);
    this.sstTex.colorSpace = THREE.SRGBColorSpace;
    this.sstTex.magFilter = THREE.LinearFilter;
    this.sstTex.minFilter = THREE.LinearFilter;
    this.sstTex.wrapS = THREE.RepeatWrapping;
    this.sstTex.wrapT = THREE.ClampToEdgeWrapping;

    const initialMode = this.state.sstMode();
    this.recolorSstTexture(this.state.sstMonth(), initialMode === 'anomaly' ? 'anomaly' : 'sst');

    const v = '?v=6';
    const texLoader = new THREE.TextureLoader();
    const globalTex = texLoader.load(`assets/data/earth-ortho-4k.jpg${v}`);
    globalTex.colorSpace = THREE.SRGBColorSpace;
    globalTex.wrapS = THREE.RepeatWrapping;
    globalTex.wrapT = THREE.ClampToEdgeWrapping;
    globalTex.minFilter = THREE.LinearFilter;
    globalTex.magFilter = THREE.LinearFilter;
    globalTex.generateMipmaps = false;

    const iberiaTex = texLoader.load(`assets/data/iberia-ortho.jpg${v}`);
    iberiaTex.colorSpace = THREE.SRGBColorSpace;
    iberiaTex.wrapS = THREE.ClampToEdgeWrapping;
    iberiaTex.wrapT = THREE.ClampToEdgeWrapping;
    iberiaTex.minFilter = THREE.LinearMipmapLinearFilter;
    iberiaTex.magFilter = THREE.LinearFilter;
    iberiaTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.orthoGlobalTex = globalTex;
    this.orthoIberiaTex = iberiaTex;
    this.globeOrthoMat = this.createGlobeOrthoMaterial(globalTex, iberiaTex);

    this.globeSstMat = new THREE.MeshLambertMaterial({
      map: this.sstTex,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });

    this.globeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.math.R, 256, 128),
      initialMode === 'ortho' ? this.globeOrthoMat : this.globeSstMat
    );
    this.globeMesh.renderOrder = 0;
    this.scene.add(this.globeMesh);
  }

  private recolorSstTexture(month: number, mode: 'sst' | 'anomaly') {
    if (!this.texData) return;
    const bin = this.sstData.sstBin;
    if (!bin && this.lastRecolorMonth !== -999 && this.lastRecolorMode === mode) return;

    this.lastRecolorMonth = month;
    this.lastRecolorMode = mode;

    const { lut, lo, hi } = mode === 'sst' ? this.math.lutSst : this.math.lutAnom;
    const sc = 255 / (hi - lo);
    const pair = this.sstData.getKeyframePair(month);
    const tex = this.texData;
    const GW = this.GW;
    const GH = this.GH;

    if (bin && pair) {
      const offsetA = pair.indexA * this.NG;
      const offsetB = pair.indexB * this.NG;
      const t = pair.t;
      const curAir = this.sstData.getInterpolatedAir(pair);
      const isAnomaly = mode === 'anomaly';
      const curZm = isAnomaly ? this.sstData.getInterpolatedZm(pair) : null;

      const rowR0 = this.sstData.rowR0;
      const rowR1 = this.sstData.rowR1;
      const rowTr = this.sstData.rowTr;
      const colC0 = this.sstData.colC0;
      const colC1 = this.sstData.colC1;
      const colTc = this.sstData.colTc;

      for (let y = 0; y < GH; y++) {
        const rowOff = y * GW;
        const zm = curZm ? curZm[y] : 0;
        const r0Off = rowR0[y] * 36;
        const r1Off = rowR1[y] * 36;
        const tr = rowTr[y];

        for (let x = 0; x < GW; x++) {
          const i = rowOff + x;
          const va = bin[offsetA + i];
          const vb = bin[offsetB + i];
          const o = i * 4;

          if (va !== 255 && vb !== 255) {
            const vByte = va + (vb - va) * t;
            const sst = vByte * 0.2 - 5.0;
            const val = isAnomaly ? sst - zm : sst;
            let k = ((val - lo) * sc + 0.5) | 0;
            if (k < 0) k = 0;
            else if (k > 255) k = 255;
            k *= 3;
            tex[o] = lut[k];
            tex[o + 1] = lut[k + 1];
            tex[o + 2] = lut[k + 2];
            tex[o + 3] = 255;
          } else if (curAir) {
            const c0 = colC0[x];
            const c1 = colC1[x];
            const tc = colTc[x];
            const top = curAir[r0Off + c0] + (curAir[r0Off + c1] - curAir[r0Off + c0]) * tc;
            const bot = curAir[r1Off + c0] + (curAir[r1Off + c1] - curAir[r1Off + c0]) * tc;
            const airTemp = top + (bot - top) * tr;
            const val = isAnomaly ? airTemp - zm : airTemp;
            let k = ((val - lo) * sc + 0.5) | 0;
            if (k < 0) k = 0;
            else if (k > 255) k = 255;
            k *= 3;
            tex[o] = lut[k];
            tex[o + 1] = lut[k + 1];
            tex[o + 2] = lut[k + 2];
            tex[o + 3] = 255;
          } else {
            tex[o] = 226;
            tex[o + 1] = 232;
            tex[o + 2] = 240;
            tex[o + 3] = 255;
          }
        }
      }
    } else {
      for (let y = 0; y < GH; y++) {
        const lat = 89.75 - y * 0.5;
        const rowOff = y * GW;
        for (let x = 0; x < GW; x++) {
          const lon = -179.75 + x * 0.5;
          const val = mode === 'sst' ? this.math.getSst(lon, lat, month) : this.math.getAnomaly(lon, lat, month);
          let k = ((val - lo) * sc + 0.5) | 0;
          if (k < 0) k = 0;
          else if (k > 255) k = 255;
          k *= 3;
          const o = (rowOff + x) * 4;
          tex[o] = lut[k];
          tex[o + 1] = lut[k + 1];
          tex[o + 2] = lut[k + 2];
          tex[o + 3] = 255;
        }
      }
    }

    // Coastal dilation (2 passes): fill 0.5° land-masked coastal cells with adjacent ocean SST
    // so the higher-resolution vector coastline never exposes 0.5° gray stair-step pixels.
    if (bin && pair) {
      const isOcean = new Uint8Array(this.NG);
      const offsetA = pair.indexA * this.NG;
      const offsetB = pair.indexB * this.NG;
      for (let i = 0; i < this.NG; i++) {
        if (bin[offsetA + i] !== 255 && bin[offsetB + i] !== 255) isOcean[i] = 1;
      }
      for (let pass = 0; pass < 2; pass++) {
        const nextOcean = new Uint8Array(isOcean);
        for (let y = 1; y < GH - 1; y++) {
          const row = y * GW;
          for (let x = 1; x < GW - 1; x++) {
            const idx = row + x;
            if (isOcean[idx]) continue;
            const n = isOcean[idx - 1]
              ? idx - 1
              : isOcean[idx + 1]
                ? idx + 1
                : isOcean[idx - GW]
                  ? idx - GW
                  : isOcean[idx + GW]
                    ? idx + GW
                    : -1;
            if (n >= 0) {
              const dst = idx * 4;
              const src = n * 4;
              tex[dst] = tex[src];
              tex[dst + 1] = tex[src + 1];
              tex[dst + 2] = tex[src + 2];
              tex[dst + 3] = 255;
              nextOcean[idx] = 1;
            }
          }
        }
        isOcean.set(nextOcean);
      }
    }

    this.sstTex.needsUpdate = true;
  }

  private initLandOverlay() {
    this.vectorGroup.add(
      this.graticuleGroup,
      this.landOrthoGroup,
      this.satTileGroup,
      this.forestGroup,
      this.osmTileGroup,
      this.urbanGroup,
      this.bordersGroup,
      this.roadGroup
    );
    this.scene.add(this.vectorGroup);
    this.buildVectorGraticule();
    this.loadLandAndRelief();
    this.syncSlippyTiles(true);
  }

  private buildVectorGraticule() {
    const R = this.math.R * 1.0004;
    const graticule = d3Geo.geoGraticule().step([30, 30]).precision(1.5)();
    const rings: [number, number][][] = [];
    for (const line of graticule.coordinates) {
      rings.push(line as [number, number][]);
    }
    this.addPolyRingsToVectorGroup(rings, R, 0x0f172a, 0.07, 1, 0.35, this.graticuleGroup);
  }

  private async loadLandAndRelief() {
    try {
      let resp = await fetch('assets/data/land-50m.json');
      if (!resp.ok) {
        resp = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json');
      }
      const topology = await resp.json();
      const landFeature = topojson.feature(topology, topology.objects.land as any);
      this.loadedLandFeature = landFeature;
      this.buildLandMask(landFeature);

      this.ngZone.run(() => {
        this.state.mapLoaded.set(true);
      });

      this.loadVectorLayers();
    } catch (err) {
      console.warn('Could not load land data:', err);
    }
  }

  private buildLandMask(land: any) {
    const mc = document.createElement('canvas');
    mc.width = 720;
    mc.height = 360;
    const mctx = mc.getContext('2d', { willReadFrequently: true });
    if (!mctx) return;
    const proj = d3Geo.geoEquirectangular().scale(720 / (2 * Math.PI)).translate([360, 180]);
    mctx.beginPath();
    d3Geo.geoPath(proj, mctx)(land);
    mctx.fillStyle = '#000';
    mctx.fill();
    const px = mctx.getImageData(0, 0, 720, 360).data;
    const mask = new Uint8Array(720 * 360);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 64 ? 1 : 0;
    this.landMask = mask;
  }

  isLand(lon: number, lat: number): boolean {
    if (this.landMask) {
      const c = this.math.clamp(Math.floor(((((lon + 180) % 360) + 360) % 360) * 2), 0, 719);
      const r = this.math.clamp(Math.floor((90 - lat) * 2), 0, 359);
      return this.landMask[r * 720 + c] === 1;
    }
    return false;
  }

  isLandPrecise(lon: number, lat: number): boolean {
    if (this.loadedLandFeature) {
      try {
        return d3Geo.geoContains(this.loadedLandFeature, [lon, lat]);
      } catch {
        // fallback
      }
    }
    return this.isLand(lon, lat);
  }

  private addPolyRingsToVectorGroup(
    rings: [number, number][][],
    radius: number,
    color: number,
    opacity: number,
    renderOrder = 5,
    maxSegDeg = 0.35,
    targetGroup: THREE.Group = this.vectorGroup
  ) {
    const pts: number[] = [];
    const pPrev = new THREE.Vector3();
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [lon0, lat0] = ring[i];
        const [lon1, lat1] = ring[i + 1];
        if (Math.abs(lon1 - lon0) > 150) continue;
        const dist = Math.hypot(lon1 - lon0, lat1 - lat0);
        const steps = Math.max(1, Math.ceil(dist / maxSegDeg));
        this.math.pos(lon0, lat0, radius, pPrev);
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          this.math.pos(lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t, radius, this.pv);
          pts.push(pPrev.x, pPrev.y, pPrev.z, this.pv.x, this.pv.y, this.pv.z);
          pPrev.copy(this.pv);
        }
      }
    }
    if (pts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = renderOrder;
    targetGroup.add(lines);
  }

  private extractFeatureRings(geojson: any): [number, number][][] {
    const rings: [number, number][][] = [];
    const features = geojson?.type === 'FeatureCollection' ? geojson.features : [geojson];
    for (const f of features ?? []) {
      const g = f?.geometry ?? f;
      if (!g) continue;
      if (g.type === 'Polygon') {
        for (const r of g.coordinates) rings.push(r);
      } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) {
          for (const r of poly) rings.push(r);
        }
      }
    }
    return rings;
  }

  private unwrapAndCleanRing(ring: [number, number][]): [number, number][] {
    if (!ring || ring.length < 3) return [];
    const raw: [number, number][] = [[ring[0][0], ring[0][1]]];
    for (let i = 1; i < ring.length; i++) {
      let lon = ring[i][0];
      const lat = ring[i][1];
      const prevLon = raw[i - 1][0];
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
      raw.push([lon, lat]);
    }
    if (raw.length > 2) {
      const first = raw[0];
      const last = raw[raw.length - 1];
      if (Math.abs(last[0] - first[0]) > 300) {
        const poleLat = first[1] < 0 ? -89.95 : 89.95;
        raw.push([last[0], poleLat], [first[0], poleLat]);
      } else if (Math.abs(first[0] - last[0]) < 1e-4 && Math.abs(first[1] - last[1]) < 1e-4) {
        raw.pop();
      }
    }
    const out: [number, number][] = [];
    for (const p of raw) {
      if (out.length > 0) {
        const prev = out[out.length - 1];
        if (Math.abs(p[0] - prev[0]) < 1e-4 && Math.abs(p[1] - prev[1]) < 1e-4) continue;
      }
      out.push(p);
    }
    return out;
  }

  private addSphericalPolygonsToVectorGroup(
    polygons: [number, number][][][],
    radius: number,
    color: number | string,
    opacity: number,
    maxEdgeDeg = 1.0,
    renderOrder = 2,
    customMaterial?: THREE.Material,
    depthWrite = false,
    targetGroup: THREE.Group = this.vectorGroup
  ) {
    const positions: number[] = [];
    const globalMaxSq = maxEdgeDeg * maxEdgeDeg;
    const iberiaMaxEdge = Math.min(maxEdgeDeg, 0.45);
    const iberiaMaxSq = iberiaMaxEdge * iberiaMaxEdge;
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();

    const inIberiaWindow = (lon: number, lat: number) =>
      lon >= -14 && lon <= 10 && lat >= 32 && lat <= 48;

    const emitSubdividedTri = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
      cx: number,
      cy: number,
      depth: number
    ) => {
      const dab = (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
      const dbc = (bx - cx) * (bx - cx) + (by - cy) * (by - cy);
      const dca = (cx - ax) * (cx - ax) + (cy - ay) * (cy - ay);
      const maxD = Math.max(dab, dbc, dca);
      const targetMaxSq =
        inIberiaWindow(ax, ay) || inIberiaWindow(bx, by) || inIberiaWindow(cx, cy)
          ? iberiaMaxSq
          : globalMaxSq;
      if (maxD <= targetMaxSq || depth >= 14) {
        this.math.pos(ax, ay, radius, va);
        this.math.pos(bx, by, radius, vb);
        this.math.pos(cx, cy, radius, vc);
        // Ensure outward-facing normal on the sphere so FrontSide hardware-culls back hemisphere
        const abx = vb.x - va.x;
        const aby = vb.y - va.y;
        const abz = vb.z - va.z;
        const acx = vc.x - va.x;
        const acy = vc.y - va.y;
        const acz = vc.z - va.z;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        if (nx * va.x + ny * va.y + nz * va.z >= 0) {
          positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
        } else {
          positions.push(va.x, va.y, va.z, vc.x, vc.y, vc.z, vb.x, vb.y, vb.z);
        }
        return;
      }
      if (dab >= dbc && dab >= dca) {
        const mx = 0.5 * (ax + bx);
        const my = 0.5 * (ay + by);
        emitSubdividedTri(ax, ay, mx, my, cx, cy, depth + 1);
        emitSubdividedTri(mx, my, bx, by, cx, cy, depth + 1);
      } else if (dbc >= dab && dbc >= dca) {
        const mx = 0.5 * (bx + cx);
        const my = 0.5 * (by + cy);
        emitSubdividedTri(ax, ay, bx, by, mx, my, depth + 1);
        emitSubdividedTri(ax, ay, mx, my, cx, cy, depth + 1);
      } else {
        const mx = 0.5 * (cx + ax);
        const my = 0.5 * (cy + ay);
        emitSubdividedTri(ax, ay, bx, by, mx, my, depth + 1);
        emitSubdividedTri(mx, my, bx, by, cx, cy, depth + 1);
      }
    };

    for (const poly of polygons) {
      if (!poly || poly.length === 0) continue;
      const outer = this.unwrapAndCleanRing(poly[0]);
      if (outer.length < 3) continue;
      let cMin = Infinity;
      let cMax = -Infinity;
      for (const [x] of outer) {
        if (x < cMin) cMin = x;
        if (x > cMax) cMax = x;
      }
      const holes = poly
        .slice(1)
        .map(h => this.unwrapAndCleanRing(h))
        .filter(h => h.length >= 3);
      for (const h of holes) {
        while (h[0][0] > cMax) for (const pt of h) pt[0] -= 360;
        while (h[0][0] < cMin) for (const pt of h) pt[0] += 360;
      }

      const contourV = outer.map(([x, y]) => new THREE.Vector2(x, y));
      const holesV = holes.map(h => h.map(([x, y]) => new THREE.Vector2(x, y)));
      const faces = THREE.ShapeUtils.triangulateShape(contourV, holesV);
      const allPts = [...contourV, ...holesV.flat()];
      for (const [a, b, c] of faces) {
        const pa = allPts[a];
        const pb = allPts[b];
        const pc = allPts[c];
        emitSubdividedTri(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y, 0);
      }
    }

    if (positions.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat =
      customMaterial ??
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: opacity < 1,
        opacity,
        side: THREE.FrontSide,
        depthWrite,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = renderOrder;
    targetGroup.add(mesh);
  }

  private createGlobeOrthoMaterial(globalTex: THREE.Texture, iberiaTex: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uGlobalOrtho: { value: globalTex },
        uIberiaOrtho: { value: iberiaTex },
        uIbLonMin: { value: -11.25 },
        uIbLonMax: { value: 5.625 },
        uIbMercMin: { value: 0.6626797059939121 },
        uIbMercMax: { value: 0.9081166341398055 }
      },
      vertexShader: /* glsl */ `
        varying vec3 vLocalPos;
        void main() {
          vLocalPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uGlobalOrtho;
        uniform sampler2D uIberiaOrtho;
        uniform float uIbLonMin;
        uniform float uIbLonMax;
        uniform float uIbMercMin;
        uniform float uIbMercMax;
        varying vec3 vLocalPos;

        void main() {
          vec3 dir = normalize(vLocalPos);
          float lonDeg = degrees(atan(-dir.z, dir.x));
          float latDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));

          vec2 globalUv = vec2((lonDeg + 180.0) / 360.0, (latDeg + 90.0) / 180.0);
          vec3 col = texture2D(uGlobalOrtho, globalUv).rgb;

          float clampedLat = clamp(latDeg, -85.0, 85.0);
          float mercY = log(tan(0.7853981633974483 + radians(clampedLat) * 0.5));
          float ibU = (lonDeg - uIbLonMin) / (uIbLonMax - uIbLonMin);
          float ibV = (mercY - uIbMercMin) / (uIbMercMax - uIbMercMin);
          if (ibU > 0.0 && ibU < 1.0 && ibV > 0.0 && ibV < 1.0) {
            vec3 iberiaCol = texture2D(uIberiaOrtho, vec2(ibU, ibV)).rgb;
            float edge = smoothstep(0.0, 0.05, ibU) * smoothstep(1.0, 0.95, ibU)
                       * smoothstep(0.0, 0.05, ibV) * smoothstep(1.0, 0.95, ibV);
            col = mix(col, iberiaCol, edge);
          }

          float diff = 0.88 + 0.14 * clamp(dot(dir, normalize(vec3(0.42, 0.78, 0.58))), 0.0, 1.0);
          gl_FragColor = vec4(col * diff, 1.0);
          #include <colorspace_fragment>
        }
      `,
      side: THREE.FrontSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2
    });
  }

  private createForestOverlayMaterial(forestTex: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uForestTex: { value: forestTex }
      },
      vertexShader: /* glsl */ `
        varying vec3 vLocalPos;
        void main() {
          vLocalPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uForestTex;
        varying vec3 vLocalPos;

        void main() {
          vec3 dir = normalize(vLocalPos);
          float lonDeg = degrees(atan(-dir.z, dir.x));
          float latDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));
          vec2 uv = vec2((lonDeg + 180.0) / 360.0, (latDeg + 90.0) / 180.0);
          vec4 samplePx = texture2D(uForestTex, uv);
          if (samplePx.a < 0.04) discard;
          gl_FragColor = samplePx;
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
  }

  private createLandOrthoMaterial(globalTex: THREE.Texture, iberiaTex: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uGlobalOrtho: { value: globalTex },
        uIberiaOrtho: { value: iberiaTex },
        uIbLonMin: { value: -11.25 },
        uIbLonMax: { value: 5.625 },
        uIbMercMin: { value: 0.6626797059939121 },
        uIbMercMax: { value: 0.9081166341398055 }
      },
      vertexShader: /* glsl */ `
        varying vec3 vLocalPos;
        void main() {
          vLocalPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uGlobalOrtho;
        uniform sampler2D uIberiaOrtho;
        uniform float uIbLonMin;
        uniform float uIbLonMax;
        uniform float uIbMercMin;
        uniform float uIbMercMax;
        varying vec3 vLocalPos;

        bool isNavyOcean(vec3 c) {
          float lum = dot(c, vec3(0.3333));
          return (c.b > c.r * 1.35 && lum < 0.08);
        }

        vec3 sampleCleanOrtho(sampler2D tex, vec2 uv, vec2 stepUv) {
          vec3 center = texture2D(tex, uv).rgb;
          if (!isNavyOcean(center)) return center;
          vec3 best = vec3(0.0);
          float bestScore = -1.0;
          vec2 offsets[8];
          offsets[0] = vec2( stepUv.x, 0.0);
          offsets[1] = vec2(-stepUv.x, 0.0);
          offsets[2] = vec2(0.0,  stepUv.y);
          offsets[3] = vec2(0.0, -stepUv.y);
          offsets[4] = vec2( stepUv.x,  stepUv.y);
          offsets[5] = vec2(-stepUv.x,  stepUv.y);
          offsets[6] = vec2( stepUv.x, -stepUv.y);
          offsets[7] = vec2(-stepUv.x, -stepUv.y);
          for (int i = 0; i < 8; i++) {
            vec3 n = texture2D(tex, uv + offsets[i]).rgb;
            if (!isNavyOcean(n)) {
              float score = n.r + n.g;
              if (score > bestScore) {
                bestScore = score;
                best = n;
              }
            }
          }
          return bestScore > 0.0 ? best : vec3(0.45, 0.48, 0.42);
        }

        void main() {
          vec3 dir = normalize(vLocalPos);
          float lonDeg = degrees(atan(-dir.z, dir.x));
          float latDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));

          vec2 globalUv = vec2((lonDeg + 180.0) / 360.0, (latDeg + 90.0) / 180.0);
          vec3 col = sampleCleanOrtho(uGlobalOrtho, globalUv, vec2(0.0005, 0.001));

          float clampedLat = clamp(latDeg, -85.0, 85.0);
          float mercY = log(tan(0.7853981633974483 + radians(clampedLat) * 0.5));
          float ibU = (lonDeg - uIbLonMin) / (uIbLonMax - uIbLonMin);
          float ibV = (mercY - uIbMercMin) / (uIbMercMax - uIbMercMin);
          if (ibU > 0.0 && ibU < 1.0 && ibV > 0.0 && ibV < 1.0) {
            vec3 iberiaCol = sampleCleanOrtho(uIberiaOrtho, vec2(ibU, ibV), vec2(0.0008, 0.0008));
            float edge = smoothstep(0.0, 0.05, ibU) * smoothstep(1.0, 0.95, ibU)
                       * smoothstep(0.0, 0.05, ibV) * smoothstep(1.0, 0.95, ibV);
            col = mix(col, iberiaCol, edge);
          }

          float diff = 0.86 + 0.16 * clamp(dot(dir, normalize(vec3(0.42, 0.78, 0.58))), 0.0, 1.0);
          col = pow(max(col, vec3(0.0)), vec3(0.92)) * 0.90 + vec3(0.025);
          gl_FragColor = vec4(col * diff, 1.0);
          #include <colorspace_fragment>
        }
      `,
      side: THREE.FrontSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });
  }

  private extractFeaturePolygons(geojson: any): [number, number][][][] {
    const polys: [number, number][][][] = [];
    const features = geojson?.type === 'FeatureCollection' ? geojson.features : [geojson];
    for (const f of features ?? []) {
      const g = f?.geometry ?? f;
      if (!g) continue;
      if (g.type === 'Polygon' && g.coordinates?.length) {
        polys.push(g.coordinates);
      } else if (g.type === 'MultiPolygon' && g.coordinates?.length) {
        for (const p of g.coordinates) {
          if (p?.length) polys.push(p);
        }
      }
    }
    return polys;
  }

  private async loadVectorLayers() {
    const R = this.math.R;
    const v = '?v=7';
    const texLoader = new THREE.TextureLoader();

    try {
      const [land10m, states10m, cities10m, roads10m, forestTex] = await Promise.all([
        fetch(`assets/data/uk-land-10m.json${v}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)),
        fetch(`assets/data/global-states-10m.json${v}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)),
        fetch(`assets/data/global-cities-10m.json${v}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)),
        fetch(`assets/data/global-roads-10m.json${v}`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)),
        texLoader.loadAsync(`assets/data/global-forests-4k.png${v}`)
      ]);

      const globalTex = this.orthoGlobalTex!;
      const iberiaTex = this.orthoIberiaTex!;

      forestTex.colorSpace = THREE.SRGBColorSpace;
      forestTex.wrapS = THREE.RepeatWrapping;
      forestTex.wrapT = THREE.ClampToEdgeWrapping;
      forestTex.minFilter = THREE.LinearFilter;
      forestTex.magFilter = THREE.LinearFilter;
      forestTex.generateMipmaps = false;
      this.forestTex = forestTex;

      // 1. Satellite orthophoto clipped strictly to unified 10m vector landmass geometry
      const landGeo = land10m?.features ? land10m : this.loadedLandFeature;
      if (landGeo) {
        const landPolys = this.extractFeaturePolygons(landGeo);
        const orthoMat = this.createLandOrthoMaterial(globalTex, iberiaTex);
        this.addSphericalPolygonsToVectorGroup(
          landPolys,
          R * 1.0007,
          '#e2e8f0',
          1.0,
          1.15,
          1,
          orthoMat,
          true,
          this.landOrthoGroup
        );
      }

      // 1b. NASA MODIS IGBP global forest canopy overlay
      const forestMesh = new THREE.Mesh(
        new THREE.SphereGeometry(R * 1.00076, 192, 96),
        this.createForestOverlayMaterial(forestTex)
      );
      forestMesh.renderOrder = 2;
      this.forestGroup.add(forestMesh);

      // 2. Global 10m urban area footprints (translucent fill + crisp border)
      if (Array.isArray(cities10m) && cities10m.length > 0) {
        const cityPolys = cities10m.map((ring: [number, number][]) => [ring]);
        this.addSphericalPolygonsToVectorGroup(
          cityPolys,
          R * 1.0008,
          0x94a3b8,
          0.36,
          0.5,
          2,
          undefined,
          false,
          this.urbanGroup
        );
        this.addPolyRingsToVectorGroup(cities10m, R * 1.00085, 0x334155, 0.62, 3, 0.5, this.urbanGroup);
      }

      // 3. Global 10m internal regional / provincial boundaries
      if (Array.isArray(states10m)) {
        this.addPolyRingsToVectorGroup(states10m, R * 1.0009, 0x475569, 0.34, 4, 0.5, this.bordersGroup);
      }

      // 4. Global 10m road & highway network
      if (roads10m?.secondary) {
        this.addPolyRingsToVectorGroup(roads10m.secondary, R * 1.00095, 0xcbd5e1, 0.22, 5, 0.5, this.roadGroup);
      }
      if (roads10m?.highways) {
        this.addPolyRingsToVectorGroup(roads10m.highways, R * 1.001, 0xf8fafc, 0.45, 6, 0.5, this.roadGroup);
      }

      // 5. Single unified country borders & coastlines
      if (landGeo) {
        this.addPolyRingsToVectorGroup(
          this.extractFeatureRings(landGeo),
          R * 1.0011,
          0x1e293b,
          0.72,
          7,
          0.35,
          this.bordersGroup
        );
      }
    } catch (err) {
      console.warn('Could not load 10m vector layers:', err);
    }
  }

  private initWildfireGroups() {
    this.scene.add(this.bboxGroup);
    this.scene.add(this.hotspotGroup);
    this.scene.add(this.spreadGroup);
    this.scene.add(this.evacuationGroup);
    this.scene.add(this.escapeRoadGroup);
    this.rebuildRegionBbox(this.state.regionBbox(), false);
  }

  private clearGroup(group: THREE.Group) {
    while (group.children.length > 0) {
      const child = group.children[0] as any;
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m: THREE.Material) => m.dispose());
        else child.material.dispose();
      }
    }
  }

  private rebuildRegionBbox(bbox: BoundingBox, isPreview: boolean) {
    this.clearGroup(this.bboxGroup);
    const [w, s, e, n] = bbox;
    const R = this.math.R;
    const edgeColor = isPreview ? 0x0284c7 : 0xd37400;
    const fillColor = isPreview ? 0x38bdf8 : 0xd37400;

    // 1. Subdivided spherical fill mesh conforming cleanly to globe curvature
    const segsLon = 14;
    const segsLat = 14;
    const verts: number[] = [];
    const rFill = R * 1.0015;
    for (let iy = 0; iy < segsLat; iy++) {
      const lat0 = this.math.lerp(s, n, iy / segsLat);
      const lat1 = this.math.lerp(s, n, (iy + 1) / segsLat);
      for (let ix = 0; ix < segsLon; ix++) {
        const lon0 = this.math.lerp(w, e, ix / segsLon);
        const lon1 = this.math.lerp(w, e, (ix + 1) / segsLon);

        const p00 = this.math.pos(lon0, lat0, rFill, new THREE.Vector3());
        const p10 = this.math.pos(lon1, lat0, rFill, new THREE.Vector3());
        const p11 = this.math.pos(lon1, lat1, rFill, new THREE.Vector3());
        const p01 = this.math.pos(lon0, lat1, rFill, new THREE.Vector3());

        verts.push(p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z);
        verts.push(p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z);
      }
    }
    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const fillMat = new THREE.MeshBasicMaterial({
      color: fillColor,
      transparent: true,
      opacity: isPreview ? 0.22 : 0.12,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.bboxGroup.add(new THREE.Mesh(fillGeo, fillMat));

    // 2. Subdivided spherical wireframe perimeter
    const rLine = R * 1.0020;
    const linePts: THREE.Vector3[] = [];
    const edgeSteps = 24;
    for (let i = 0; i <= edgeSteps; i++) {
      linePts.push(this.math.pos(this.math.lerp(w, e, i / edgeSteps), n, rLine, new THREE.Vector3()));
    }
    for (let i = 1; i <= edgeSteps; i++) {
      linePts.push(this.math.pos(e, this.math.lerp(n, s, i / edgeSteps), rLine, new THREE.Vector3()));
    }
    for (let i = 1; i <= edgeSteps; i++) {
      linePts.push(this.math.pos(this.math.lerp(e, w, i / edgeSteps), s, rLine, new THREE.Vector3()));
    }
    for (let i = 1; i <= edgeSteps; i++) {
      linePts.push(this.math.pos(w, this.math.lerp(s, n, i / edgeSteps), rLine, new THREE.Vector3()));
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({
      color: edgeColor,
      transparent: true,
      opacity: isPreview ? 0.98 : 0.92
    });
    this.bboxGroup.add(new THREE.Line(lineGeo, lineMat));

    // 3. Corner anchor dots
    const corners: [number, number][] = [
      [w, n],
      [e, n],
      [e, s],
      [w, s]
    ];
    const dotGeo = new THREE.CircleGeometry(0.055, 16);
    const dotMat = new THREE.MeshBasicMaterial({
      color: edgeColor,
      side: THREE.DoubleSide
    });
    for (const [cx, cy] of corners) {
      const cp = this.math.pos(cx, cy, R * 1.0022, new THREE.Vector3());
      const dot = new THREE.Mesh(dotGeo.clone(), dotMat.clone());
      dot.position.copy(cp);
      dot.lookAt(cp.clone().multiplyScalar(2));
      this.bboxGroup.add(dot);
    }
    dotGeo.dispose();
    dotMat.dispose();
  }

  private rebuildGlobeHotspots(
    hotspots: { lon: number; lat: number; harmonizedCount: number; frpMw: number }[],
    rampId: 'okabeIto' | 'cividis' | 'viridis' | 'ylOrRd'
  ) {
    this.clearGroup(this.hotspotGroup);
    if (!hotspots || hotspots.length === 0) return;

    // Limit rendered instances cleanly if huge custom dataset is imported
    const maxRender = 2500;
    const step = hotspots.length > maxRender ? Math.ceil(hotspots.length / maxRender) : 1;
    const sampled = step === 1 ? hotspots : hotspots.filter((_, idx) => idx % step === 0);

    const maxCount = Math.max(1, ...sampled.map(h => h.harmonizedCount));
    // Draw lower-intensity cells first so intense fire clusters sit cleanly on top
    const ordered = [...sampled].sort((a, b) => a.harmonizedCount - b.harmonizedCount);
    const R = this.math.R;
    const dense = ordered.length > 350;
    const geo = new THREE.CircleGeometry(dense ? 0.022 : 0.036, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.FrontSide,
      transparent: true,
      opacity: dense ? 0.72 : 0.86,
      depthWrite: false
    });

    const mesh = new THREE.InstancedMesh(geo, mat, ordered.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    for (let i = 0; i < ordered.length; i++) {
      const h = ordered[i];
      const norm = Math.min(1, Math.pow(h.harmonizedCount / maxCount, 0.58));
      const p = this.math.pos(h.lon, h.lat, R * (1.0018 + norm * 0.0004), this.pv);
      dummy.position.copy(p);
      dummy.lookAt(p.x * 2, p.y * 2, p.z * 2);
      const scale = dense ? 0.42 + norm * 1.35 : 0.65 + norm * 1.25;
      dummy.scale.set(scale, scale, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const [r, g, b] = this.ramps.sampleRgb(rampId, norm);
      color.setRGB(r / 255, g / 255, b / 255);
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.hotspotGroup.add(mesh);
  }

  private rebuildSpreadCells(frameIdx: number, scenario: 'actual' | 'atlanticSurge' | 'levanteReversal' | 'elNinoDroughtBoost') {
    this.clearGroup(this.spreadGroup);
    const frames = this.data.spreadFrames()?.frames;
    if (!frames || frames.length === 0) return;
    const frame = frames[Math.max(0, Math.min(frames.length - 1, frameIdx))];
    const R = this.math.R;

    const hexGeo = new THREE.CircleGeometry(0.068, 6);
    for (const cell of frame.cells) {
      const prob = cell.scenarios[scenario];
      if (prob < 0.25) continue;

      const p = this.math.pos(cell.lon, cell.lat, R * 1.0018, new THREE.Vector3());
      const color = prob >= 0.78 ? 0xdc2626 : prob >= 0.52 ? 0xd37400 : 0xf59e0b;
      const mat = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.45 + prob * 0.45
      });
      const hex = new THREE.Mesh(hexGeo, mat);
      hex.position.copy(p);
      hex.lookAt(p.clone().multiplyScalar(2));
      this.spreadGroup.add(hex);
    }
  }

  private rebuildEvacuationZones(frameIdx: number, scenario: 'actual' | 'atlanticSurge' | 'levanteReversal' | 'elNinoDroughtBoost') {
    this.clearGroup(this.evacuationGroup);
    const zones = this.data.evacuation()?.zones ?? [];
    const R = this.math.R;
    const mult = scenario === 'elNinoDroughtBoost' ? 1.32 : scenario === 'atlanticSurge' ? 1.24 : scenario === 'levanteReversal' ? 1.12 : 1.0;
    const frameScale = 0.75 + (frameIdx / 11) * 0.45;

    for (const z of zones) {
      const p = this.math.pos(z.lon, z.lat, R * 1.0019, new THREE.Vector3());
      const radius = z.radiusDeg * 0.25 * mult * frameScale;
      const ringGeo = new THREE.RingGeometry(radius * 0.68, radius, 32);
      const color = z.riskLevel === 'critical' ? 0xdc2626 : z.riskLevel === 'high' ? 0xd37400 : 0x0284c7;
      const ringMat = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.78
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(p);
      ring.lookAt(p.clone().multiplyScalar(2));
      this.evacuationGroup.add(ring);
    }
  }

  private rebuildEscapeRoads() {
    this.clearGroup(this.escapeRoadGroup);
    const roads = this.data.evacuation()?.escapeRoads ?? [];
    const R = this.math.R;

    for (const road of roads) {
      const pts = road.coords.map(([lon, lat]) => this.math.pos(lon, lat, R * 1.0021, new THREE.Vector3()));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: 0x059669,
        transparent: true,
        opacity: 0.95
      });
      this.escapeRoadGroup.add(new THREE.Line(geo, mat));
    }
  }

  /**
   * Windy-style animated wind vector streamlines over the Iberian Peninsula
   */
  private initWindStreamlines() {
    const segs = this.WIND_COUNT * (this.WIND_TRAIL - 1);
    const pos = new Float32Array(segs * 6);
    const col = new Float32Array(segs * 6);

    this.windStreaks = [];
    for (let i = 0; i < this.WIND_COUNT; i++) {
      const s: WindStreak = {
        lon: -11 + Math.random() * 15,
        lat: 35 + Math.random() * 9.5,
        age: Math.random() * 1.2,
        maxAge: 0.9 + Math.random() * 0.9,
        hist: new Array(this.WIND_TRAIL * 3).fill(0)
      };
      this.resetWindStreak(s);
      this.windStreaks.push(s);
    }

    this.windGeo = new THREE.BufferGeometry();
    this.windGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.windGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false
    });

    this.windLines = new THREE.LineSegments(this.windGeo, mat);
    this.windLines.visible = this.state.showWindStreamlines();
    this.scene.add(this.windLines);
  }

  private resetWindStreak(s: WindStreak) {
    s.lon = -11 + Math.random() * 15;
    s.lat = 35 + Math.random() * 9.5;
    s.age = 0;
    this.math.pos(s.lon, s.lat, this.math.R * 1.0024, this.pv);
    for (let k = 0; k < this.WIND_TRAIL; k++) {
      s.hist[k * 3] = this.pv.x;
      s.hist[k * 3 + 1] = this.pv.y;
      s.hist[k * 3 + 2] = this.pv.z;
    }
  }

  private updateWindStreamlines(dt: number) {
    if (!this.windGeo || !this.windLines || !this.windLines.visible) return;

    const dirRad = (this.state.effectiveWindDirDeg() * Math.PI) / 180;
    const speed = (this.state.effectiveWindSpeedKmh() / 40) * 3.8;
    const uBase = Math.sin(dirRad) * speed;
    const vBase = Math.cos(dirRad) * speed;

    const posArr = (this.windGeo.attributes['position'] as THREE.BufferAttribute).array as Float32Array;
    const colArr = (this.windGeo.attributes['color'] as THREE.BufferAttribute).array as Float32Array;
    const R = this.math.R;

    let ptr = 0;
    for (let i = 0; i < this.WIND_COUNT; i++) {
      const s = this.windStreaks[i];
      s.age += dt;
      if (s.age > s.maxAge || s.lon < -12 || s.lon > 5 || s.lat < 34 || s.lat > 45) {
        this.resetWindStreak(s);
      } else {
        const curl = Math.sin(s.lon * 0.6) * 0.45;
        s.lon += (uBase + curl) * dt;
        s.lat += (vBase - curl * 0.4) * dt;

        for (let k = this.WIND_TRAIL - 1; k > 0; k--) {
          s.hist[k * 3] = s.hist[(k - 1) * 3];
          s.hist[k * 3 + 1] = s.hist[(k - 1) * 3 + 1];
          s.hist[k * 3 + 2] = s.hist[(k - 1) * 3 + 2];
        }
        this.math.pos(s.lon, s.lat, R * 1.0024, this.pv);
        s.hist[0] = this.pv.x;
        s.hist[1] = this.pv.y;
        s.hist[2] = this.pv.z;
      }

      const lifeAlpha = Math.sin(Math.min(1, s.age / s.maxAge) * Math.PI);
      for (let k = 0; k < this.WIND_TRAIL - 1; k++) {
        const a = k * 3;
        const b = (k + 1) * 3;
        posArr[ptr] = s.hist[a];
        posArr[ptr + 1] = s.hist[a + 1];
        posArr[ptr + 2] = s.hist[a + 2];
        posArr[ptr + 3] = s.hist[b];
        posArr[ptr + 4] = s.hist[b + 1];
        posArr[ptr + 5] = s.hist[b + 2];

        const fade0 = (1 - k / (this.WIND_TRAIL - 1)) * lifeAlpha;
        const fade1 = (1 - (k + 1) / (this.WIND_TRAIL - 1)) * lifeAlpha;
        colArr[ptr] = 0.05 + 0.85 * (1 - fade0);
        colArr[ptr + 1] = 0.35 + 0.55 * (1 - fade0);
        colArr[ptr + 2] = 0.65 + 0.30 * (1 - fade0);
        colArr[ptr + 3] = 0.05 + 0.85 * (1 - fade1);
        colArr[ptr + 4] = 0.35 + 0.55 * (1 - fade1);
        colArr[ptr + 5] = 0.65 + 0.30 * (1 - fade1);
        ptr += 6;
      }
    }

    this.windGeo.attributes['position'].needsUpdate = true;
    this.windGeo.attributes['color'].needsUpdate = true;
  }

  private raycastSphereDir(clientX: number, clientY: number, outDir: THREE.Vector3): boolean {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.mouseVec.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseVec.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.mouseVec, this.camera);
    const hit = this.raycaster.ray.intersectSphere(this.grabSphere, this.grabHit);
    if (!hit) return false;
    outDir.copy(hit).normalize();
    return true;
  }

  private dirToLonLat(unitDir: THREE.Vector3): [number, number] {
    const lat = 90 - Math.acos(this.math.clamp(unitDir.y, -1, 1)) * (180 / Math.PI);
    const lon = Math.atan2(unitDir.z, -unitDir.x) * (180 / Math.PI) - 180;
    const normLon = ((lon + 540) % 360) - 180;
    return [Number(normLon.toFixed(2)), Number(this.math.clamp(lat, -85, 85).toFixed(2))];
  }

  private buildSortedBbox(a: [number, number], b: [number, number]): BoundingBox {
    const w = Math.min(a[0], b[0]);
    const e = Math.max(a[0], b[0]);
    const s = Math.min(a[1], b[1]);
    const n = Math.max(a[1], b[1]);
    return [w, s, e, n];
  }

  onPointerDown(ev: PointerEvent) {
    this.isCamAnimating = false;
    if (ev.button === 0 || ev.pointerType === 'touch') {
      const dir = new THREE.Vector3();
      if (this.raycastSphereDir(ev.clientX, ev.clientY, dir)) {
        const wantsDraw = this.state.isDrawingBbox() || ev.shiftKey;
        if (wantsDraw) {
          this.isDraggingBbox = true;
          this.drawAnchorLonLat = this.dirToLonLat(dir);
          this.controls.enabled = false;
          this.ngZone.run(() => {
            if (this.drawAnchorLonLat) {
              this.state.liveDrawBbox.set(this.buildSortedBbox(this.drawAnchorLonLat, this.drawAnchorLonLat));
            }
          });
        } else {
          this.grabDir = dir;
          this.isDraggingGlobe = true;
        }
        try {
          this.canvasRef.nativeElement.setPointerCapture(ev.pointerId);
        } catch {
          // ignore if unsupported
        }
      }
    }
  }

  onPointerMove(ev: PointerEvent) {
    if (this.isDraggingBbox && this.drawAnchorLonLat) {
      if (!this.raycastSphereDir(ev.clientX, ev.clientY, this.grabCur)) return;
      const curLonLat = this.dirToLonLat(this.grabCur);
      const preview = this.buildSortedBbox(this.drawAnchorLonLat, curLonLat);
      this.rebuildRegionBbox(preview, true);
      this.ngZone.run(() => this.state.liveDrawBbox.set(preview));
      return;
    }

    if (!this.isDraggingGlobe || !this.grabDir) return;
    if (!this.raycastSphereDir(ev.clientX, ev.clientY, this.grabCur)) return;

    this.grabQuat.setFromUnitVectors(this.grabCur, this.grabDir);
    const dist = this.camera.position.length();
    this.camera.position.applyQuaternion(this.grabQuat);

    // Clamp polar angle away from poles to keep north-up orientation stable
    const r = this.camera.position.length() || dist;
    const phi = Math.acos(this.math.clamp(this.camera.position.y / r, -1, 1));
    const minPhi = 0.12;
    const maxPhi = Math.PI - 0.12;
    if (phi < minPhi || phi > maxPhi) {
      const clampedPhi = this.math.clamp(phi, minPhi, maxPhi);
      const horiz = Math.hypot(this.camera.position.x, this.camera.position.z) || 1e-6;
      const newHoriz = r * Math.sin(clampedPhi);
      this.camera.position.x *= newHoriz / horiz;
      this.camera.position.z *= newHoriz / horiz;
      this.camera.position.y = r * Math.cos(clampedPhi);
    }

    this.camera.position.setLength(dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
  }

  onPointerUp(ev: PointerEvent) {
    if (this.isDraggingBbox) {
      const anchor = this.drawAnchorLonLat;
      this.isDraggingBbox = false;
      this.drawAnchorLonLat = null;
      this.controls.enabled = true;
      try {
        this.canvasRef.nativeElement.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }

      const endDir = new THREE.Vector3();
      const gotEnd = this.raycastSphereDir(ev.clientX, ev.clientY, endDir);
      const live = this.state.liveDrawBbox();
      this.ngZone.run(() => {
        if (anchor && gotEnd) {
          const finalBox = this.buildSortedBbox(anchor, this.dirToLonLat(endDir));
          this.state.finishDrawBoundingBox(finalBox);
        } else if (live) {
          this.state.finishDrawBoundingBox(live);
        } else {
          this.state.cancelDrawBoundingBox();
        }
      });
      return;
    }

    this.isDraggingGlobe = false;
    this.grabDir = null;
    try {
      this.canvasRef.nativeElement.releasePointerCapture(ev.pointerId);
    } catch {
      // ignore
    }
  }

  private handleResize() {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || !this.renderer || !this.camera) return;
    this.canvasWidth = canvas.clientWidth || window.innerWidth;
    this.canvasHeight = canvas.clientHeight || window.innerHeight;
    this.camera.aspect = this.canvasWidth / (this.canvasHeight || 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.canvasWidth, this.canvasHeight, false);
  }

  private readonly animate = (now: number) => {
    this.animId = requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, (now - (this.lastTime || now)) / 1000);
    this.lastTime = now;

    if (this.isCamAnimating) {
      const elapsed = now - this.camAnimStart;
      const t = Math.min(1, elapsed / this.camAnimDuration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.camStartPos, this.camTargetPos, ease);
      if (t >= 1) this.isCamAnimating = false;
    }

    this.updateWindStreamlines(dt);

    if (this.state.playing()) {
      this.ngZone.run(() => {
        if (this.state.viewMode() === 'inertia') {
          const total = Math.max(1, this.state.aoiTimeline().length);
          this.state.timelineIndex.update(idx => (idx + dt * 2.5) % total);
        } else {
          this.state.frameIndex.update(f => (f + dt * 1.5) % 12);
        }
      });
    }

    const camDist = this.camera.position.length();
    const alt = Math.max(0.02, camDist - this.math.R);
    this.controls.zoomSpeed = this.math.clamp(alt * 0.22, 0.05, 0.65);
    const targetNear = Math.min(0.5, Math.max(0.004, alt * 0.2));
    if (Math.abs(this.camera.near - targetNear) > 0.002) {
      this.camera.near = targetNear;
      this.camera.updateProjectionMatrix();
    }

    this.syncSlippyTiles(false, now);

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private syncSlippyTiles(force: boolean, now = performance.now()) {
    if (!this.camera || !this.scene) return;
    if (!force && now - this.lastTileSyncTime < 160) return;

    const camDist = this.camera.position.length();
    this.pv.copy(this.camera.position).normalize();
    const [centerLon, centerLat] = this.dirToLonLat(this.pv);
    const z = this.tiles.computeOptimalZoom(
      camDist,
      this.camera.fov,
      this.canvasHeight || window.innerHeight,
      centerLat,
      2,
      16
    );

    const tileKey = `${z}:${Math.round(centerLon * 2)}:${Math.round(centerLat * 2)}:${this.state.showOsmTiles()}:${this.state.showLandOrtho()}:${this.state.sstMode()}`;
    if (!force && tileKey === this.lastTileKey) return;

    this.lastTileSyncTime = now;
    this.lastTileKey = tileKey;

    if (z !== this.lastTileZoom) {
      this.lastTileZoom = z;
      this.ngZone.run(() => this.state.activeTileZoom.set(z));
    }

    const showSatDetail = this.state.showLandOrtho() && this.state.sstMode() === 'ortho' && z >= 5;
    this.tiles.syncLayerTiles({
      group: this.satTileGroup,
      provider: 'sat',
      enabled: showSatDetail,
      z,
      centerLon,
      centerLat,
      baseRadiusFactor: 1.00072,
      renderOrderBase: 2
    });

    this.tiles.syncLayerTiles({
      group: this.osmTileGroup,
      provider: 'osm',
      enabled: this.state.showOsmTiles(),
      z,
      centerLon,
      centerLat,
      baseRadiusFactor: 1.00079,
      renderOrderBase: 40
    });
  }
}
