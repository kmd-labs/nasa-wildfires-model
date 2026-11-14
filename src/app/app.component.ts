import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  LucideAngularModule,
  Globe,
  Flame,
  Wind,
  ShieldAlert,
  BookOpen,
  Database,
  Play,
  Pause,
  Compass,
  Layers,
  Route,
  BoxSelect,
  X,
  BarChart3
} from 'lucide-angular';
import {
  BrandComponent,
  ButtonComponent,
  DropdownComponent,
  DropdownOption,
  PopupComponent,
  PopupService,
  SplashComponent,
  SplashService,
  AboutService,
  TimelineSliderComponent,
  TooltipComponent,
  BreakpointService,
  SeoService
} from '@kmd/design-system';
import { I18nService } from './core/i18n/i18n.service';
import { Lang } from './core/i18n/i18n.types';
import { WildfireStateService } from './core/services/wildfire-state.service';
import { WildfireDataService } from './core/services/wildfire-data.service';
import { HotspotAnalyticsService } from './core/services/hotspot-analytics.service';
import { WildfireViewMode, WindScenarioId } from './core/models/wildfire.model';
import { GlobeComponent } from './components/globe/globe.component';
import { GlossaryComponent } from './components/glossary/glossary.component';
import { SourcesPopupComponent } from './components/sources-popup/sources-popup.component';
import { AnalyticsPanelComponent } from './components/analytics-panel/analytics-panel.component';
import { LayersComponent } from './components/layers/layers.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    LucideAngularModule,
    BrandComponent,
    ButtonComponent,
    DropdownComponent,
    PopupComponent,
    SplashComponent,
    TimelineSliderComponent,
    TooltipComponent,
    GlobeComponent,
    AnalyticsPanelComponent,
    LayersComponent
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  readonly i18n = inject(I18nService);
  readonly bp = inject(BreakpointService);
  readonly popup = inject(PopupService);
  readonly about = inject(AboutService);
  readonly splash = inject(SplashService);
  readonly seo = inject(SeoService);
  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly analytics = inject(HotspotAnalyticsService);

  readonly globeIcon = Globe;
  readonly bookOpenIcon = BookOpen;
  readonly databaseIcon = Database;
  readonly playIcon = Play;
  readonly pauseIcon = Pause;
  readonly compassIcon = Compass;
  readonly layersIcon = Layers;
  readonly routeIcon = Route;
  readonly boxSelectIcon = BoxSelect;
  readonly closeIcon = X;
  readonly chartIcon = BarChart3;

  constructor() {
    this.seo.update({
      title: 'KMD · Global Wildfire Analytics & Climate Inertia',
      description: 'Interactive 3D Globe visualization of global wildfires, harmonized MODIS+VIIRS burning calendar, Gulf Stream & El Niño climate inertia, wind-driven spread, and evacuation impact.',
      image: 'assets/design-system/og-image.png'
    });
  }

  readonly langOptions = computed<DropdownOption<Lang>[]>(() =>
    this.i18n.langs.map(l => ({
      value: l,
      label: this.i18n.dicts[l].langName,
      shortLabel: l.toUpperCase(),
      badge: l.toUpperCase()
    }))
  );

  readonly viewOptions = computed<DropdownOption<WildfireViewMode>[]>(() => {
    const t = this.i18n.t();
    return [
      { value: 'analytics', label: t.viewAnalytics, icon: BarChart3 },
      { value: 'inertia', label: t.viewInertia, icon: Flame },
      { value: 'spread', label: t.viewSpread, icon: Wind },
      { value: 'evacuation', label: t.viewEvacuation, icon: ShieldAlert }
    ];
  });

  readonly scenarioOptions = computed<DropdownOption<WindScenarioId>[]>(() => {
    const t = this.i18n.t();
    return [
      { value: 'actual', label: t.scenarioActual },
      { value: 'atlanticSurge', label: t.scenarioAtlanticSurge },
      { value: 'levanteReversal', label: t.scenarioLevanteReversal },
      { value: 'elNinoDroughtBoost', label: t.scenarioElNinoDrought }
    ];
  });

  readonly aoiOptions = computed<DropdownOption<string>[]>(() => {
    const t = this.i18n.t();
    const list: DropdownOption<string>[] = [
      { value: 'iberia_all', label: t.regionIberiaAll, badge: 'ALL' }
    ];
    if (this.state.selectedAoiId() === 'custom') {
      list.push({ value: 'custom', label: t.regionCustomBbox, badge: 'BOX' });
    }
    for (const a of this.data.aois()) {
      list.push({
        value: a.aoiId,
        label: a.name,
        badge: String(a.year)
      });
    }
    return list;
  });

  readonly currentViewIcon = computed(
    () => this.viewOptions().find(o => o.value === this.state.viewMode())?.icon ?? BarChart3
  );

  readonly isPopupOpen = computed(() => this.popup.config() !== null);

  readonly sliderMax = computed(() =>
    this.state.viewMode() === 'inertia'
      ? Math.max(1, this.state.aoiTimeline().length - 1)
      : 11
  );
  readonly sliderValue = computed(() =>
    this.state.viewMode() === 'inertia'
      ? Math.round(this.state.timelineIndex())
      : Math.round(this.state.frameIndex())
  );

  onSliderChange(val: number) {
    this.state.playing.set(false);
    if (this.state.viewMode() === 'inertia') {
      this.state.timelineIndex.set(val);
    } else {
      this.state.frameIndex.set(val);
    }
  }

  openAnalyticsView() {
    this.state.isAnalyticsMinimized.set(false);
    this.state.setViewMode('analytics');
  }

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
}
