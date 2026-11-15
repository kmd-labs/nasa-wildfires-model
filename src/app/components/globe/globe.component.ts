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
import { BreakpointService } from '@kmd/design-system';
import { ThemeService } from '@kmd/design-system/services/theme.service';
import { isAtMost, isMobileLandscape } from '@kmd/design-system/utils/breakpoints';
import { GlobeMathService } from '../../core/services/globe-math.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { WildfireStateService, ringToClosedPolygonCoords } from '../../core/services/wildfire-state.service';
import { ColorRampService } from '../../core/services/color-ramp.service';
import { GlobePixelSquare, HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';
import { GlobeTileService } from '../../core/services/globe-tile.service';
import { BoundingBox, ColorRampId, MultiPolygonCoords, PolygonCoords, PolygonRing } from '../../core/models/wildfire.model';
import { LonLat, ScreenPt, clipPolygonToTriangle, findNearestEdgePx, findNearestVertexPx } from '../../core/utils/polygon-clip';
import { USER_LOCATION_PIN_COLOR, drawUserLocationPin } from '../../core/utils/location-pin';
import { getUnobstructedViewportBounds } from '../../core/utils/viewport-framing';
import {
  STATIC_GLOW_LEVEL,
  hotspotGlowRgb,
  clusterOutlineEdges,
  hotspotGlowLevel,
  prefersReducedMotion
} from '../../core/utils/hotspot-glow';

/** Glow ribbon width on the globe, as a share of the hotspot cell size (outside / inside the edge). */
const GLOW_OUTER_CELLS = 0.85;
const GLOW_INNER_CELLS = 0.25;

const MIN_GLOBE_DISTANCE = 10.25;
/** Max zoom-out camera distance framing the full Iberian Peninsula and France. */
const MAX_GLOBE_DISTANCE_DESKTOP = 19.5;
const MAX_GLOBE_DISTANCE_PORTRAIT = 22.0;
const MAX_GLOBE_TILE_ZOOM = 14;

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

  // OpenStreetMap + Satellite orthophoto tile basemaps and wildfire overlay groups
  private readonly osmTileGroup = new THREE.Group();
  private readonly satTileGroup = new THREE.Group();
  private readonly bordersGroup = new THREE.Group();
  private bordersLoading = false;
  private bordersLoaded = false;
  private isDestroyed = false;
  private lastTileSyncTime = 0;
  private lastTileZoom = -1;
  private lastTileKey = '';
  private readonly bboxGroup = new THREE.Group();
  private readonly hotspotGroup = new THREE.Group();
  private hotspotGlowMat: THREE.MeshBasicMaterial | null = null;
  private hotspotGlowStart = 0;
  private readonly userLocationGroup = new THREE.Group();

  // Interactive BBox & N-edge polygon editing state
  private isDraggingBbox = false;
  private drawAnchorLonLat: [number, number] | null = null;
  private draggingVertexIdx: number | null = null;

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
  private canvasWidth = 1;
  private canvasHeight = 1;

  private readonly pv = new THREE.Vector3();

  constructor() {
    // React to orthophoto map and administrative borders toggles
    effect(() => {
      const showOrtho = this.state.showLandOrtho();
      const showBorders = showOrtho && this.state.showBorders();
      if (this.scene) {
        untracked(() => {
          this.bordersGroup.visible = showBorders;
          if (showBorders && !this.bordersLoaded && !this.bordersLoading) {
            void this.loadBordersLayer();
          }
          this.syncSlippyTiles(true);
        });
      }
    });

    // React to sidepanel minimize/expand before the user manually pans or zooms
    let panelFramingInitialized = false;
    effect(() => {
      this.state.isAnalyticsMinimized();
      this.state.isAnalyticsExpanded();
      if (!panelFramingInitialized) {
        panelFramingInitialized = true;
        return;
      }
      if (this.camera && this.controls) {
        untracked(() => {
          if (isAtMost('tablet') || this.state.userCamera3d() !== null) return;
          const bbox = this.state.regionBbox();
          if (bbox) {
            this.flyToBbox(bbox);
          } else {
            const [lon, lat] = this.state.bboxCenter();
            this.flyToFocus(this.state.cameraFocus(), this.state.viewMode(), lon, lat);
          }
        });
      }
    });

    // React to view mode or camera focus preset changes
    let focusInitialized = false;
    effect(() => {
      const focus = this.state.cameraFocus();
      const view = this.state.viewMode();
      if (!focusInitialized) {
        focusInitialized = true;
        return;
      }
      if (this.camera) {
        const [lon, lat] = untracked(() => this.state.bboxCenter());
        untracked(() => {
          this.state.userCamera3d.set(null);
          this.flyToFocus(focus, view, lon, lat);
        });
      }
    });

    // React to explicit fly-to-bbox requests
    let lastFlyTrigger = untracked(() => this.state.flyToBboxTrigger());
    effect(() => {
      const trigger = this.state.flyToBboxTrigger();
      if (trigger > lastFlyTrigger && this.camera) {
        lastFlyTrigger = trigger;
        const bbox = untracked(() => this.state.regionBbox());
        if (bbox) {
          untracked(() => this.flyToBbox(bbox));
        }
      }
    });

    // React to region MultiPolygon, draft polygon, or live draw preview changes
    effect(() => {
      const live = this.state.liveDrawBbox();
      const draft = this.state.draftPolygon();
      const multi = this.state.regionMultiPolygon();
      const mode = this.state.drawBoxMode();
      const showBbox = this.state.showRegionBbox();
      if (this.scene) {
        untracked(() => {
          this.bboxGroup.visible = showBbox || live !== null;
          this.rebuildRegionMultiPolygon(multi, draft, live, mode === 'add');
        });
      }
    });

    // React to active dataset pixel squares, MultiPolygon boundary, color ramp, and globe visibility toggle
    effect(() => {
      const squares = this.analytics.globePixelSquares();
      const multi = this.state.regionMultiPolygon();
      const ramp = this.state.colorRamp();
      const show = this.state.showHotspotsOnGlobe();
      if (this.scene) {
        untracked(() => {
          this.hotspotGroup.visible = show;
          this.rebuildGlobePixelSquares(squares, multi, ramp);
        });
      }
    });

    // React to current user location pin visibility & coordinates
    effect(() => {
      this.state.showUserLocation();
      this.state.userLocation();
      if (this.scene) {
        untracked(() => this.rebuildUserLocationPin());
      }
    });
  }

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      this.initThree();
      this.initBaseGlobe();
      this.initWildfireGroups();

      window.addEventListener('resize', this.onResize);
      this.animate(0);

      this.data.loadAll().then(() => {
        this.rebuildRegionMultiPolygon(
          this.state.regionMultiPolygon(),
          this.state.draftPolygon(),
          this.state.liveDrawBbox(),
          this.state.drawBoxMode() === 'add'
        );
        this.rebuildGlobePixelSquares(
          this.analytics.globePixelSquares(),
          this.state.regionMultiPolygon(),
          this.state.colorRamp()
        );
      });
    });
  }

  ngOnDestroy() {
    this.isDestroyed = true;
    if (this.animId !== null) cancelAnimationFrame(this.animId);
    window.removeEventListener('resize', this.onResize);
    this.clearGroup(this.bordersGroup);
    this.controls?.removeEventListener('start', this.onControlsStart);
    this.controls?.removeEventListener('end', this.onControlsEnd);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.tiles.disposeAll();
  }

  private readonly onResize = () => this.handleResize();

  private readonly onControlsStart = () => {
    this.isCamAnimating = false;
  };

  private readonly onControlsEnd = () => {
    this.persistUserCamera3d();
  };

  private maxGlobeDistance(): number {
    const aspect = this.canvasWidth / (this.canvasHeight || 1);
    return aspect < 0.85 ? MAX_GLOBE_DISTANCE_PORTRAIT : MAX_GLOBE_DISTANCE_DESKTOP;
  }

  private desktopRightOffsetLonDeg(targetLat: number, camDist: number): number {
    const framing = getUnobstructedViewportBounds(
      this.canvasWidth,
      this.canvasHeight,
      this.state.isAnalyticsMinimized(),
      this.state.isAnalyticsExpanded()
    );
    if (framing.isMobile || isAtMost('tablet') || this.state.isAnalyticsMinimized()) return 0;

    const shiftPx = framing.desiredCenterX - this.canvasWidth * 0.5;
    const tanHalfFov = Math.tan(((this.camera?.fov ?? 40) * Math.PI) / 360);
    const nx = (shiftPx / Math.max(1, this.canvasHeight * 0.5)) * tanHalfFov;
    const alt = Math.max(0.25, camDist - this.math.R);
    const sinAlpha = this.math.clamp((alt / this.math.R) * nx, -0.5, 0.5);
    const cosLat = Math.max(0.4, Math.cos((targetLat * Math.PI) / 180));
    return ((Math.asin(sinAlpha) * 180) / Math.PI) / cosLat;
  }

  private persistUserCamera3d(): void {
    if (!this.camera) return;
    const dist = this.math.clamp(this.camera.position.length(), MIN_GLOBE_DISTANCE, this.maxGlobeDistance());
    const unit = this.camera.position.clone().normalize();
    const [lon, lat] = this.dirToLonLat(unit);
    this.ngZone.run(() => {
      this.state.userCamera3d.set({ lon, lat, dist });
      this.state.cameraTargetLonLat.set([lon, lat]);
    });
  }

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
    const maxDist = this.maxGlobeDistance();
    const saved = this.state.userCamera3d();
    if (saved) {
      const clampedDist = this.math.clamp(saved.dist, MIN_GLOBE_DISTANCE, maxDist);
      this.math.pos(saved.lon, saved.lat, clampedDist, this.camTargetPos);
      this.camera.position.copy(this.camTargetPos);
      this.isCamAnimating = false;
    } else {
      const hasInitialBbox = this.state.regionBbox() !== null;
      const initialDist = this.math.clamp(
        hasInitialBbox
          ? (portrait ? 20.5 : isLand ? 16.5 : 17.5)
          : (portrait ? 21.5 : isLand ? 17.5 : 19.0),
        MIN_GLOBE_DISTANCE,
        maxDist
      );
      const [initLon, initLat] = this.state.bboxCenter();
      const targetLon = initLon - this.desktopRightOffsetLonDeg(initLat, initialDist);

      this.math.pos(targetLon, initLat, initialDist, this.camTargetPos);
      this.math.pos(targetLon - 6.0, initLat + 3.0, Math.min(maxDist, initialDist * 1.15), this.camStartPos);

      this.camera.position.copy(this.camStartPos);
      this.isCamAnimating = true;
      this.camAnimStart = performance.now();
    }

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.enableRotate = false; // Handled by 1:1 surface-grabbing
    this.controls.zoomSpeed = 0.45;
    this.controls.minDistance = MIN_GLOBE_DISTANCE;
    this.controls.maxDistance = maxDist;
    this.controls.enablePan = false;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('start', this.onControlsStart);
    this.controls.addEventListener('end', this.onControlsEnd);
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
      lon = aoiLon - this.desktopRightOffsetLonDeg(lat, dist);
    } else if (focus === 'northAtlantic') {
      lon = -35.0;
      lat = 39.0;
      dist = 28.0 * scale;
    } else if (focus === 'pacificEnso') {
      lon = -140.0;
      lat = 2.0;
      dist = 31.0 * scale;
    }

    dist = this.math.clamp(dist, MIN_GLOBE_DISTANCE, this.maxGlobeDistance());
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
    const targetDist = this.math.clamp((10.25 + spanDeg * 0.55) * scale, MIN_GLOBE_DISTANCE, this.maxGlobeDistance());
    const targetLon = centerLon - this.desktopRightOffsetLonDeg(centerLat, targetDist);

    this.camStartPos.copy(this.camera.position);
    this.math.pos(targetLon, centerLat, targetDist, this.camTargetPos);
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

  private initBaseGlobe() {
    this.globeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.math.R, 128, 64),
      new THREE.MeshLambertMaterial({
        color: 0xaad3df,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2
      })
    );
    this.globeMesh.renderOrder = 0;
    this.scene.add(this.globeMesh);

    this.scene.add(this.osmTileGroup);
    this.scene.add(this.satTileGroup);
    this.scene.add(this.bordersGroup);
    const showBorders = this.state.showLandOrtho() && this.state.showBorders();
    this.bordersGroup.visible = showBorders;
    if (showBorders && !this.bordersLoaded && !this.bordersLoading) {
      void this.loadBordersLayer();
    }
    this.syncSlippyTiles(true);
    this.ngZone.run(() => this.state.mapLoaded.set(true));
  }

  private initWildfireGroups() {
    this.scene.add(this.bboxGroup);
    this.scene.add(this.hotspotGroup);
    this.scene.add(this.userLocationGroup);
    this.bboxGroup.visible = this.state.showRegionBbox() || this.state.liveDrawBbox() !== null;
    this.rebuildRegionMultiPolygon(
      this.state.regionMultiPolygon(),
      this.state.draftPolygon(),
      this.state.liveDrawBbox(),
      this.state.drawBoxMode() === 'add'
    );
    this.rebuildUserLocationPin();
  }

  private clearGroup(group: THREE.Group) {
    while (group.children.length > 0) {
      const child = group.children[0] as any;
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    }
  }

  private rebuildUserLocationPin(): void {
    this.clearGroup(this.userLocationGroup);
    if (!this.state.showUserLocation()) return;
    const loc = this.state.userLocation();
    if (!loc) return;

    const R = this.math.R;
    const haloPos = this.math.pos(loc.lon, loc.lat, R * 1.0025, new THREE.Vector3());
    const haloGeo = new THREE.CircleGeometry(1, 24);
    const haloMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(USER_LOCATION_PIN_COLOR),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.25,
      depthWrite: false
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    haloMesh.position.copy(haloPos);
    haloMesh.lookAt(haloPos.clone().multiplyScalar(2));
    haloMesh.userData['handlePx'] = 9;
    haloMesh.renderOrder = 44;
    this.userLocationGroup.add(haloMesh);

    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        drawUserLocationPin(ctx, 32, 56, 46);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const spriteMat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.position.copy(this.math.pos(loc.lon, loc.lat, R * 1.003, new THREE.Vector3()));
      sprite.center.set(0.5, 8 / 64);
      sprite.userData['handlePx'] = 34;
      sprite.renderOrder = 45;
      this.userLocationGroup.add(sprite);
    }

    this.updateBboxHandleScales();
  }

  private rebuildRegionMultiPolygon(
    multi: MultiPolygonCoords,
    draftPoly: PolygonRing | null,
    livePreview: BoundingBox | null,
    isAddMode: boolean
  ) {
    this.clearGroup(this.bboxGroup);

    if ((!livePreview && !draftPoly) || isAddMode) {
      for (const poly of multi) {
        this.addSphericalPolygonToGroup(poly, false);
      }
    }

    if (draftPoly && draftPoly.length >= 3 && !livePreview) {
      this.addSphericalPolygonToGroup(ringToClosedPolygonCoords(draftPoly), true);
    }

    if (livePreview) {
      const [w, s, e, n] = livePreview;
      const previewPoly: PolygonCoords = [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s]
        ]
      ];
      this.addSphericalPolygonToGroup(previewPoly, true);
    }
  }

  private cleanRing(ring: PolygonRing): [number, number][] {
    const pts: [number, number][] = [];
    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i];
      if (i === ring.length - 1 && pts.length > 0 && Math.abs(pt[0] - pts[0][0]) < 1e-6 && Math.abs(pt[1] - pts[0][1]) < 1e-6) {
        continue;
      }
      if (pts.length > 0 && Math.abs(pt[0] - pts[pts.length - 1][0]) < 1e-6 && Math.abs(pt[1] - pts[pts.length - 1][1]) < 1e-6) {
        continue;
      }
      pts.push(pt);
    }
    return pts;
  }

  private getEditableActivePoly(): PolygonRing | null {
    if (!this.state.showRegionBbox()) return null;
    const draft = this.state.draftPolygon();
    if (draft && draft.length >= 3) return draft;
    if (this.state.regionBorderMultiPolygon()) return null;
    const region = this.state.regionPolygon();
    return region && region.length >= 3 && region.length <= 32 ? region : null;
  }

  private addSphericalPolygonToGroup(poly: PolygonCoords, isPreview: boolean) {
    if (!poly || poly.length === 0 || poly[0].length < 3) return;
    const R = this.math.R;
    const edgeColor = isPreview ? 0x0284c7 : 0xd37400;
    const fillColor = isPreview ? 0x38bdf8 : 0xd37400;

    const outerPts = this.cleanRing(poly[0]);
    if (outerPts.length < 3) return;

    const contourV2 = outerPts.map(([x, y]) => new THREE.Vector2(x, y));
    const holesPts = poly.slice(1).map(r => this.cleanRing(r)).filter(r => r.length >= 3);
    const holesV2 = holesPts.map(r => r.map(([x, y]) => new THREE.Vector2(x, y)));

    // 1. Triangulate 2D polygon and subdivide large spherical triangles so fill hugs the globe
    const allPts: [number, number][] = [...outerPts];
    for (const h of holesPts) allPts.push(...h);

    const triIndices = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
    const rFill = R * 1.0018;
    const verts: number[] = [];
    const maxEdgeDeg = 2.4;
    const vTmp = new THREE.Vector3();

    const emitSubdividedTri = (
      a: [number, number],
      b: [number, number],
      c: [number, number],
      depth: number
    ) => {
      const dab = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const dbc = Math.hypot(b[0] - c[0], b[1] - c[1]);
      const dca = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const maxD = Math.max(dab, dbc, dca);

      if (depth < 6 && maxD > maxEdgeDeg) {
        if (dab >= dbc && dab >= dca) {
          const m: [number, number] = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
          emitSubdividedTri(a, m, c, depth + 1);
          emitSubdividedTri(m, b, c, depth + 1);
        } else if (dbc >= dab && dbc >= dca) {
          const m: [number, number] = [(b[0] + c[0]) * 0.5, (b[1] + c[1]) * 0.5];
          emitSubdividedTri(a, b, m, depth + 1);
          emitSubdividedTri(a, m, c, depth + 1);
        } else {
          const m: [number, number] = [(c[0] + a[0]) * 0.5, (c[1] + a[1]) * 0.5];
          emitSubdividedTri(a, b, m, depth + 1);
          emitSubdividedTri(m, b, c, depth + 1);
        }
        return;
      }

      this.math.pos(a[0], a[1], rFill, vTmp);
      verts.push(vTmp.x, vTmp.y, vTmp.z);
      this.math.pos(b[0], b[1], rFill, vTmp);
      verts.push(vTmp.x, vTmp.y, vTmp.z);
      this.math.pos(c[0], c[1], rFill, vTmp);
      verts.push(vTmp.x, vTmp.y, vTmp.z);
    };

    for (const [ia, ib, ic] of triIndices) {
      const a = allPts[ia];
      const b = allPts[ib];
      const c = allPts[ic];
      if (a && b && c) {
        emitSubdividedTri(a, b, c, 0);
      }
    }

    if (verts.length > 0) {
      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const fillMat = new THREE.MeshBasicMaterial({
        color: fillColor,
        transparent: true,
        opacity: isPreview ? 0.22 : 0.13,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const fillMesh = new THREE.Mesh(fillGeo, fillMat);
      fillMesh.renderOrder = 40;
      this.bboxGroup.add(fillMesh);
    }

    // 2. Subdivided spherical perimeter lines for outer and hole rings
    const rLine = R * 1.0021;
    const ringsToDraw = [outerPts, ...holesPts];
    for (const ring of ringsToDraw) {
      const linePts: THREE.Vector3[] = [];
      for (let i = 0; i < ring.length; i++) {
        const p0 = ring[i];
        const p1 = ring[(i + 1) % ring.length];
        const dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const steps = Math.max(1, Math.min(48, Math.ceil(dist / 1.5)));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          linePts.push(
            this.math.pos(
              this.math.lerp(p0[0], p1[0], t),
              this.math.lerp(p0[1], p1[1], t),
              rLine,
              new THREE.Vector3()
            )
          );
        }
      }
      if (linePts.length > 0) {
        linePts.push(linePts[0].clone());
        const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
        const lineMat = new THREE.LineBasicMaterial({
          color: edgeColor,
          transparent: true,
          opacity: isPreview ? 0.98 : 0.92
        });
        const borderLine = new THREE.Line(lineGeo, lineMat);
        borderLine.renderOrder = 41;
        this.bboxGroup.add(borderLine);
      }
    }

    // 3. Vertex anchor dots + edge midpoint cues (unit circles scaled to constant CSS pixel size)
    if (outerPts.length >= 3 && outerPts.length <= 32 && holesPts.length === 0 && (isPreview || !this.state.regionBorderMultiPolygon())) {
      const dotGeo = new THREE.CircleGeometry(1, 16);
      const dotMat = new THREE.MeshBasicMaterial({
        color: edgeColor,
        side: THREE.DoubleSide
      });
      const midGeo = new THREE.CircleGeometry(1, 12);
      const midMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9
      });
      for (let i = 0; i < outerPts.length; i++) {
        const [cx, cy] = outerPts[i];
        const cp = this.math.pos(cx, cy, R * 1.0023, new THREE.Vector3());
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.copy(cp);
        dot.lookAt(cp.clone().multiplyScalar(2));
        dot.userData['handlePx'] = 4;
        dot.renderOrder = 42;
        this.bboxGroup.add(dot);

        const nextPt = outerPts[(i + 1) % outerPts.length];
        const mp = this.math.pos((cx + nextPt[0]) * 0.5, (cy + nextPt[1]) * 0.5, R * 1.00225, new THREE.Vector3());
        const midDot = new THREE.Mesh(midGeo, midMat);
        midDot.position.copy(mp);
        midDot.lookAt(mp.clone().multiplyScalar(2));
        midDot.userData['handlePx'] = 2.8;
        midDot.renderOrder = 42;
        this.bboxGroup.add(midDot);
      }
      this.updateBboxHandleScales();
    }
  }

  private rebuildGlobePixelSquares(
    squares: GlobePixelSquare[],
    regionMulti: MultiPolygonCoords,
    rampId: ColorRampId
  ) {
    this.clearGroup(this.hotspotGroup);
    this.hotspotGlowMat = null;
    if (!squares || squares.length === 0 || !regionMulti || regionMulti.length === 0) return;

    interface TriBucket {
      minLon: number;
      maxLon: number;
      minLat: number;
      maxLat: number;
      tris: { pts: [LonLat, LonLat, LonLat]; minLon: number; maxLon: number; minLat: number; maxLat: number }[];
    }

    const buckets: TriBucket[] = [];
    for (const poly of regionMulti) {
      if (!poly || poly.length === 0) continue;
      const outerPts = this.cleanRing(poly[0]);
      if (outerPts.length < 3) continue;

      const holesPts = poly.slice(1).map(r => this.cleanRing(r)).filter(r => r.length >= 3);
      const contourV2 = outerPts.map(([x, y]) => new THREE.Vector2(x, y));
      const holesV2 = holesPts.map(r => r.map(([x, y]) => new THREE.Vector2(x, y)));
      const allPts: LonLat[] = [...outerPts];
      for (const h of holesPts) allPts.push(...h);

      const triIndices = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
      if (triIndices.length === 0) continue;

      const tris: TriBucket['tris'] = [];
      let bMinLon = Infinity;
      let bMaxLon = -Infinity;
      let bMinLat = Infinity;
      let bMaxLat = -Infinity;
      for (const [ia, ib, ic] of triIndices) {
        const a = allPts[ia];
        const b = allPts[ib];
        const c = allPts[ic];
        if (!a || !b || !c) continue;
        const minLon = Math.min(a[0], b[0], c[0]);
        const maxLon = Math.max(a[0], b[0], c[0]);
        const minLat = Math.min(a[1], b[1], c[1]);
        const maxLat = Math.max(a[1], b[1], c[1]);
        if (minLon < bMinLon) bMinLon = minLon;
        if (maxLon > bMaxLon) bMaxLon = maxLon;
        if (minLat < bMinLat) bMinLat = minLat;
        if (maxLat > bMaxLat) bMaxLat = maxLat;
        tris.push({ pts: [a, b, c], minLon, maxLon, minLat, maxLat });
      }
      if (tris.length > 0) {
        buckets.push({ minLon: bMinLon, maxLon: bMaxLon, minLat: bMinLat, maxLat: bMaxLat, tris });
      }
    }
    if (buckets.length === 0) return;

    // Sort lower-intensity pixels first; clip each true-scale square against the MultiPolygon region
    const ordered = [...squares].sort((a, b) => a.normIntensity - b.normIntensity);
    const R = this.math.R;
    const positions: number[] = [];
    const colors: number[] = [];
    const vTmp = this.pv;

    for (const sq of ordered) {
      const halfLat = sq.halfLat;
      const halfLon = sq.halfLon;
      const minLon = sq.lon - halfLon;
      const maxLon = sq.lon + halfLon;
      const minLat = sq.lat - halfLat;
      const maxLat = sq.lat + halfLat;
      const sqRing: LonLat[] = [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat]
      ];

      const [r8, g8, b8] = this.ramps.sampleRgb(rampId, sq.normIntensity);
      const cr = r8 / 255;
      const cg = g8 / 255;
      const cb = b8 / 255;
      // Place pixels flush on top of the surface tiles rather than floating like clouds
      const rSurf = R * 1.00125;

      for (const bucket of buckets) {
        if (maxLon < bucket.minLon || minLon > bucket.maxLon || maxLat < bucket.minLat || minLat > bucket.maxLat) {
          continue;
        }
        for (const tri of bucket.tris) {
          if (maxLon < tri.minLon || minLon > tri.maxLon || maxLat < tri.minLat || minLat > tri.maxLat) {
            continue;
          }
          const clipped = clipPolygonToTriangle(sqRing, tri.pts);
          if (clipped.length < 3) continue;
          for (let k = 1; k < clipped.length - 1; k++) {
            const p0 = clipped[0];
            const p1 = clipped[k];
            const p2 = clipped[k + 1];
            this.math.pos(p0[0], p0[1], rSurf, vTmp);
            positions.push(vTmp.x, vTmp.y, vTmp.z);
            colors.push(cr, cg, cb);
            this.math.pos(p1[0], p1[1], rSurf, vTmp);
            positions.push(vTmp.x, vTmp.y, vTmp.z);
            colors.push(cr, cg, cb);
            this.math.pos(p2[0], p2[1], rSurf, vTmp);
            positions.push(vTmp.x, vTmp.y, vTmp.z);
            colors.push(cr, cg, cb);
          }
        }
      }
    }

    if (positions.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 45;
    this.hotspotGroup.add(mesh);

    this.addHotspotGlow(squares, regionMulti, R * 1.0013, rampId);
  }

  /**
   * Red glow ribbon along the outer edge of hotspot clusters: a strip fading out from each
   * outer edge (and slightly inwards), drawn with additive blending. Its opacity pulses in
   * `animate` (two quick beats, then one every 3 s; static with prefers-reduced-motion).
   */
  private addHotspotGlow(squares: GlobePixelSquare[], regionMulti: MultiPolygonCoords, rSurf: number, rampId: ColorRampId) {
    this.hotspotGlowMat = null;
    const edges = clusterOutlineEdges(squares, regionMulti);
    if (edges.length === 0) return;

    const [r8, g8, b8] = hotspotGlowRgb(rampId);
    const cr = r8 / 255;
    const cg = g8 / 255;
    const cb = b8 / 255;
    const positions: number[] = [];
    const colors: number[] = [];
    const v = this.pv;
    const push = (lon: number, lat: number, alpha: number) => {
      this.math.pos(lon, lat, rSurf, v);
      positions.push(v.x, v.y, v.z);
      colors.push(cr, cg, cb, alpha);
    };
    // quad between edge (a0,a1 at alpha aIn) and edge shifted by (dx,dy) (alpha aOut), as two triangles
    const quad = (e: (typeof edges)[number], dx: number, dy: number, aIn: number, aOut: number) => {
      push(e.lon0, e.lat0, aIn);
      push(e.lon1, e.lat1, aIn);
      push(e.lon1 + dx, e.lat1 + dy, aOut);
      push(e.lon0, e.lat0, aIn);
      push(e.lon1 + dx, e.lat1 + dy, aOut);
      push(e.lon0 + dx, e.lat0 + dy, aOut);
    };
    for (const e of edges) {
      const ox = e.nx * e.wLon;
      const oy = e.ny * e.wLat;
      quad(e, ox * GLOW_OUTER_CELLS, oy * GLOW_OUTER_CELLS, 1, 0);
      quad(e, -ox * GLOW_INNER_CELLS, -oy * GLOW_INNER_CELLS, 1, 0);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: STATIC_GLOW_LEVEL,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5
    });
    const glow = new THREE.Mesh(geo, mat);
    glow.renderOrder = 46;
    this.hotspotGroup.add(glow);
    this.hotspotGlowMat = mat;
    this.hotspotGlowStart = performance.now();
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
        const hitLonLat = this.dirToLonLat(dir);
        const wantsDraw = this.state.isDrawingBbox() || ev.shiftKey;
        if (wantsDraw) {
          this.isDraggingBbox = true;
          this.drawAnchorLonLat = hitLonLat;
          this.controls.enabled = false;
          this.ngZone.run(() => {
            if (this.drawAnchorLonLat) {
              this.state.liveDrawBbox.set(this.buildSortedBbox(this.drawAnchorLonLat, this.drawAnchorLonLat));
            }
          });
        } else {
          const activePoly = this.getEditableActivePoly();
          const rect = this.canvasRef.nativeElement.getBoundingClientRect();
          const px = ev.clientX - rect.left;
          const py = ev.clientY - rect.top;
          const screenPts = activePoly ? this.projectPolyToScreenPx(activePoly) : [];
          const hitVertexIdx = screenPts.length >= 3 ? findNearestVertexPx(px, py, screenPts) : -1;

          if (hitVertexIdx >= 0) {
            this.draggingVertexIdx = hitVertexIdx;
            this.controls.enabled = false;
            this.ngZone.run(() => this.state.updateDraftVertex(hitVertexIdx, hitLonLat));
          } else if (screenPts.length >= 3) {
            const bestEdgeIdx = findNearestEdgePx(px, py, screenPts);
            if (bestEdgeIdx >= 0) {
              this.controls.enabled = false;
              this.ngZone.run(() => {
                const inserted = this.state.insertPolygonVertex(bestEdgeIdx, hitLonLat);
                if (inserted !== null) {
                  this.draggingVertexIdx = inserted;
                }
              });
            } else {
              this.grabDir = dir;
              this.isDraggingGlobe = true;
            }
          } else {
            this.grabDir = dir;
            this.isDraggingGlobe = true;
          }
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
    if (this.draggingVertexIdx !== null) {
      if (!this.raycastSphereDir(ev.clientX, ev.clientY, this.grabCur)) return;
      const curLonLat = this.dirToLonLat(this.grabCur);
      const idx = this.draggingVertexIdx;
      this.ngZone.run(() => this.state.updateDraftVertex(idx, curLonLat));
      return;
    }

    if (this.isDraggingBbox && this.drawAnchorLonLat) {
      if (!this.raycastSphereDir(ev.clientX, ev.clientY, this.grabCur)) return;
      const curLonLat = this.dirToLonLat(this.grabCur);
      const preview = this.buildSortedBbox(this.drawAnchorLonLat, curLonLat);
      this.rebuildRegionMultiPolygon(
        this.state.regionMultiPolygon(),
        null,
        preview,
        this.state.drawBoxMode() === 'add'
      );
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
    if (this.draggingVertexIdx !== null) {
      this.draggingVertexIdx = null;
      this.controls.enabled = true;
      try {
        this.canvasRef.nativeElement.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      return;
    }

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

    const wasDraggingGlobe = this.isDraggingGlobe;
    this.isDraggingGlobe = false;
    this.grabDir = null;
    try {
      this.canvasRef.nativeElement.releasePointerCapture(ev.pointerId);
    } catch {
      // ignore
    }
    if (wasDraggingGlobe) {
      this.persistUserCamera3d();
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
    if (this.controls) {
      this.controls.minDistance = MIN_GLOBE_DISTANCE;
      this.controls.maxDistance = this.maxGlobeDistance();
    }
    if (this.state.userCamera3d() === null) {
      const bbox = this.state.regionBbox();
      if (bbox) {
        this.flyToBbox(bbox);
      }
    }
  }

  private readonly animate = (now: number) => {
    this.animId = requestAnimationFrame(this.animate);
    this.lastTime = now;

    if (this.isCamAnimating) {
      const elapsed = now - this.camAnimStart;
      const t = Math.min(1, elapsed / this.camAnimDuration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.camStartPos, this.camTargetPos, ease);
      if (t >= 1) this.isCamAnimating = false;
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

    if (this.hotspotGlowMat) {
      this.hotspotGlowMat.opacity = prefersReducedMotion()
        ? STATIC_GLOW_LEVEL
        : hotspotGlowLevel(now - this.hotspotGlowStart);
    }

    this.controls.update();
    this.updateBboxHandleScales();
    this.renderer.render(this.scene, this.camera);
  };

  /** Keep 3D handle dots and location pin a constant CSS pixel size across all camera zoom distances. */
  private updateBboxHandleScales() {
    if (!this.camera) return;
    const h = Math.max(1, this.canvasHeight || window.innerHeight);
    const halfTan = Math.tan((this.camera.fov * Math.PI) / 360);
    for (const group of [this.bboxGroup, this.userLocationGroup]) {
      if (!group || group.children.length === 0) continue;
      for (const child of group.children) {
        const targetPx = child.userData?.['handlePx'] as number | undefined;
        if (!targetPx) continue;
        const dist = this.camera.position.distanceTo(child.position);
        const pxToWorld = (2 * dist * halfTan) / h;
        child.scale.setScalar(targetPx * pxToWorld);
      }
    }
  }

  /** Project ring vertices on the visible front hemisphere to CSS screen pixels. */
  private projectPolyToScreenPx(poly: PolygonRing): (ScreenPt | null)[] {
    if (!this.camera) return [];
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const w = rect.width || this.canvasWidth || window.innerWidth;
    const h = rect.height || this.canvasHeight || window.innerHeight;
    const r = this.math.R * 1.0023;
    const rSq = r * r;
    const camPos = this.camera.position;
    this.camera.updateMatrixWorld();

    return poly.map(([lon, lat]) => {
      const world = this.math.pos(lon, lat, r, new THREE.Vector3());
      if (world.dot(camPos) <= rSq) return null;
      const projected = world.project(this.camera);
      return [(projected.x * 0.5 + 0.5) * w, (-projected.y * 0.5 + 0.5) * h] as ScreenPt;
    });
  }

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
      MAX_GLOBE_TILE_ZOOM
    );

    const tileKey = `${z}:${Math.round(centerLon * 2)}:${Math.round(centerLat * 2)}`;
    if (!force && tileKey === this.lastTileKey) return;

    this.lastTileSyncTime = now;
    this.lastTileKey = tileKey;

    const prevTarget = this.state.cameraTargetLonLat();
    const shifted = Math.hypot(centerLon - prevTarget[0], centerLat - prevTarget[1]) >= 0.5;
    if (z !== this.lastTileZoom || shifted) {
      this.lastTileZoom = z;
      this.ngZone.run(() => {
        this.state.activeTileZoom.set(z);
        if (shifted) {
          this.state.cameraTargetLonLat.set([centerLon, centerLat]);
        }
      });
    }

    this.tiles.syncLayerTiles({
      group: this.osmTileGroup,
      provider: 'osm',
      enabled: true,
      z,
      centerLon,
      centerLat,
      baseRadiusFactor: 1.0008,
      renderOrderBase: 1,
      onTileLoaded: () => {
        this.lastTileKey = '';
      }
    });

    this.tiles.syncLayerTiles({
      group: this.satTileGroup,
      provider: 'sat',
      enabled: this.state.showLandOrtho(),
      z,
      centerLon,
      centerLat,
      baseRadiusFactor: 1.0011,
      renderOrderBase: 18,
      onTileLoaded: () => {
        this.lastTileKey = '';
      }
    });
  }

  private async loadBordersLayer(): Promise<void> {
    this.bordersLoading = true;
    try {
      const [statesResp, countriesResp] = await Promise.all([
        fetch('assets/data/global-states-10m.json'),
        fetch('assets/data/uk-land-10m.json')
      ]);
      if (this.isDestroyed) return;
      const states10m = statesResp.ok ? await statesResp.json() : null;
      const countriesGeo = countriesResp.ok ? await countriesResp.json() : null;
      if (this.isDestroyed) return;

      const R = this.math.R;
      this.clearGroup(this.bordersGroup);
      if (Array.isArray(states10m)) {
        this.addPolyRingsToBordersGroup(states10m, R * 1.0015, 0xe2e8f0, 0.45, 36, 0.5);
      }
      if (countriesGeo) {
        this.addPolyRingsToBordersGroup(
          this.extractFeatureRings(countriesGeo),
          R * 1.0016,
          0xf8fafc,
          0.72,
          37,
          0.35
        );
      }
      this.bordersLoaded = true;
    } catch {
      // ignore vector border fetch failures
    } finally {
      this.bordersLoading = false;
    }
  }

  private addPolyRingsToBordersGroup(
    rings: [number, number][][],
    radius: number,
    color: number,
    opacity: number,
    renderOrder: number,
    maxSegDeg: number
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
      depthWrite: false
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = renderOrder;
    this.bordersGroup.add(lines);
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
}
