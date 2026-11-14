import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  LucideAngularModule,
  Globe,
  BookOpen,
  Database,
  Upload,
  BoxSelect,
  Check,
  X
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
  TooltipComponent,
  BreakpointService,
  SeoService
} from '@kmd/design-system';
import { I18nService } from './core/i18n/i18n.service';
import { Lang } from './core/i18n/i18n.types';
import { WildfireStateService } from './core/services/wildfire-state.service';
import { WildfireDataService } from './core/services/wildfire-data.service';
import { HotspotAnalyticsService } from './core/services/hotspot-analytics.service';
import { GlobeComponent } from './components/globe/globe.component';
import { GlossaryComponent } from './components/glossary/glossary.component';
import { SourcesPopupComponent } from './components/sources-popup/sources-popup.component';
import { DataPopupComponent } from './components/data-popup/data-popup.component';
import { AnalyticsPanelComponent } from './components/analytics-panel/analytics-panel.component';

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
    TooltipComponent,
    GlobeComponent,
    AnalyticsPanelComponent
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
  readonly uploadIcon = Upload;
  readonly boxSelectIcon = BoxSelect;
  readonly checkIcon = Check;
  readonly closeIcon = X;

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
    this.popup.open({
      id: 'data-io',
      title: computed(() => this.i18n.t().tabInputExport),
      component: DataPopupComponent,
      size: 'lg',
      actions: [{ label: computed(() => this.i18n.t().close), variant: 'default' }]
    });
  }
}
