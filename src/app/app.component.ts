import { Component, NgZone, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  LucideAngularModule,
  Globe,
  Map as MapIcon,
  BookOpen,
  Database,
  Download,
  BoxSelect,
  Check,
  X,
  Settings,
  Github
} from 'lucide-angular';
import {
  BrandComponent,
  ButtonComponent,
  PopupComponent,
  PopupService,
  SplashComponent,
  SplashService,
  AboutService,
  SwitcherComponent,
  SwitcherOption,
  TooltipComponent,
  TooltipDirective,
  BreakpointService,
  SeoService
} from '@kmd/design-system';
import { breakpointPx, isAtMost } from '@kmd/design-system/utils/breakpoints';
import { I18nService } from './core/i18n/i18n.service';
import { ThemePrefService } from './core/services/theme-pref.service';
import { MapRenderMode } from './core/models/wildfire.model';
import { WildfireStateService } from './core/services/wildfire-state.service';
import { WildfireDataService } from './core/services/wildfire-data.service';
import { HotspotAnalyticsService } from './core/services/hotspot-analytics.service';
import { GlobeComponent } from './components/globe/globe.component';
import { Map2dComponent } from './components/map2d/map2d.component';
import { GlossaryComponent } from './components/glossary/glossary.component';
import { SourcesPopupComponent } from './components/sources-popup/sources-popup.component';
import { openExportPopup } from './components/data-popup/data-popup.component';
import { openSettingsPopup } from './components/settings-popup/settings-popup.component';
import { AnalyticsPanelComponent } from './components/analytics-panel/analytics-panel.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    LucideAngularModule,
    BrandComponent,
    ButtonComponent,
    PopupComponent,
    SplashComponent,
    SwitcherComponent,
    TooltipComponent,
    TooltipDirective,
    GlobeComponent,
    Map2dComponent,
    AnalyticsPanelComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnDestroy {
  readonly i18n = inject(I18nService);
  private readonly themePref = inject(ThemePrefService);
  readonly bp = inject(BreakpointService);
  private readonly ngZone = inject(NgZone);
  readonly popup = inject(PopupService);
  readonly about = inject(AboutService);
  readonly splash = inject(SplashService);
  readonly seo = inject(SeoService);
  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly analytics = inject(HotspotAnalyticsService);

  readonly isMobileView = signal(false);
  readonly brandHovered = signal(false);
  readonly brandMountKey = computed(
    () => `${this.isMobileView()}:${this.bp.mobile()}:${this.bp.mobileLandscape()}`
  );
  private compactMql: MediaQueryList | null = null;
  private readonly syncViewportMode = () => {
    const next = this.compactMql ? this.compactMql.matches : isAtMost('desktop');
    if (next !== this.isMobileView()) {
      this.ngZone.run(() => {
        this.isMobileView.set(next);
        this.brandHovered.set(false);
      });
    }
  };
  private readonly onCompactMqlChange = () => this.syncViewportMode();
  private readonly onWindowResize = () => this.syncViewportMode();

  readonly globeIcon = Globe;
  readonly mapIcon = MapIcon;
  readonly bookOpenIcon = BookOpen;
  readonly databaseIcon = Database;
  readonly downloadIcon = Download;
  readonly boxSelectIcon = BoxSelect;
  readonly checkIcon = Check;
  readonly closeIcon = X;
  readonly settingsIcon = Settings;
  readonly githubIcon = Github;
  readonly githubUrl = 'https://github.com/kmd-labs/nasa-wildfires-model';

  readonly bannerDismissed = signal(false);
  readonly showRecalculateBanner = computed(
    () =>
      this.state.isDrawingBbox() ||
      this.state.liveDrawBbox() !== null ||
      (this.state.needsRecalculate() && !this.bannerDismissed())
  );

  constructor() {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.compactMql = window.matchMedia(`(max-width: ${breakpointPx('desktop')}px)`);
      this.isMobileView.set(this.compactMql.matches);
      this.compactMql.addEventListener('change', this.onCompactMqlChange);
      window.addEventListener('resize', this.onWindowResize);
    }

    this.seo.update({
      title: 'KMD · Wildfire Data Harmonization',
      description: 'Interactive 2D Map & 3D Globe visualization for Wildfire Data Harmonization across MODIS and VIIRS active fire hotspots with a harmonized burning calendar.',
      image: 'assets/design-system/og-image.png'
    });

    effect(() => {
      this.state.draftPolygon();
      this.state.draftDateStart();
      this.state.draftDateEnd();
      this.state.isDrawingBbox();
      this.bannerDismissed.set(false);
    });
  }

  ngOnDestroy(): void {
    this.compactMql?.removeEventListener('change', this.onCompactMqlChange);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWindowResize);
    }
  }

  dismissDrawBanner(): void {
    if (this.state.isDrawingBbox() || this.state.liveDrawBbox()) {
      this.state.cancelDrawBoundingBox();
    } else {
      this.bannerDismissed.set(true);
    }
  }

  readonly mapModeOptions = computed<SwitcherOption<MapRenderMode>[]>(() => {
    const t = this.i18n.t();
    return [
      { value: '2d', label: t.mapMode2d, shortLabel: '2D', icon: this.mapIcon },
      { value: 'globe', label: t.mapModeGlobe, shortLabel: '3D', icon: this.globeIcon }
    ];
  });

  readonly isPopupOpen = computed(() => this.popup.config() !== null);

  openGlossary() {
    this.popup.open({
      id: 'glossary',
      title: computed(() => this.i18n.t().glossaryTitle),
      component: GlossaryComponent,
      size: 'lg',
      actions: [{ label: computed(() => this.i18n.t().close), variant: 'default' }]
    });
  }

  openSources() {
    this.popup.open({
      id: 'sources',
      title: computed(() => this.i18n.t().sourcesTitle),
      component: SourcesPopupComponent,
      size: 'lg',
      actions: [{ label: computed(() => this.i18n.t().close), variant: 'default' }]
    });
  }

  openDataPopup() {
    openExportPopup(this.popup, this.i18n);
  }

  openSettings() {
    openSettingsPopup(this.popup, this.i18n);
  }
}
