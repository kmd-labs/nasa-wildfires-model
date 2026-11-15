import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  LucideAngularModule,
  Download,
  FileSpreadsheet,
  FileJson,
  Image
} from 'lucide-angular';
import { ButtonComponent, PopupService } from '@kmd/design-system';
import { I18nService } from '../../core/i18n/i18n.service';
import { WildfireStateService } from '../../core/services/wildfire-state.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import {
  BackendCalibrationModel,
  BackendCalibrationPlatform,
  BackendValidationScore
} from '../../core/models/wildfire.model';

@Component({
  selector: 'app-data-popup',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, ButtonComponent, LocaleDatePipe],
  templateUrl: './data-popup.component.html',
  styleUrl: './data-popup.component.scss'
})
export class DataPopupComponent {
  readonly i18n = inject(I18nService);
  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly analytics = inject(HotspotAnalyticsService);

  readonly downloadIcon = Download;
  readonly csvIcon = FileSpreadsheet;
  readonly jsonIcon = FileJson;
  readonly imageIcon = Image;

  /** Validation of the harmonization for this area (#86): all held-out years and per era. */
  readonly validation = computed(() => {
    const v = this.data.backendCalendar()?.validation ?? null;
    const all = v?.allTestYears ?? null;
    if (!v || !all) return null;
    const eras = Object.entries(v.byEra ?? {})
      .filter((e): e is [string, BackendValidationScore] => e[1] !== null && e[1] !== undefined)
      .map(([era, s]) => ({ era, ...s }));
    return { all, eras };
  });

  /** Calibration of the harmonization for this area (#87): efficiencies, MODIS drift, VIIRS chain. */
  readonly calibration = computed(() => {
    const cal = this.data.backendCalendar()?.metadata.calibration;
    if (!cal) return null;
    const model = (cal['model'] ?? {}) as BackendCalibrationModel;
    const platforms = ['TERRA', 'AQUA', 'SNPP', 'NOAA20', 'NOAA21']
      .filter(p => cal[p] && typeof (cal[p] as BackendCalibrationPlatform).efficiency === 'number')
      .map(p => ({ name: PLATFORM_NAMES[p] ?? p, efficiency: (cal[p] as BackendCalibrationPlatform).efficiency as number }));
    const drift = ['TERRA', 'AQUA']
      .filter(p => model.modisDrift?.[p])
      .map(p => {
        const d = model.modisDrift![p];
        return {
          name: PLATFORM_NAMES[p],
          shiftHours: d.latestShiftHours ?? null,
          factor: d.D?.latestFactor ?? null,
          fromPrior: d.D?.form === 'prior' || d.N?.form === 'prior'
        };
      });
    const usesPrior = drift.some(d => d.fromPrior);
    return {
      version: model.version ?? null,
      platforms,
      drift,
      usesPrior,
      intervalMultiplier: model.intervalMultiplier ?? null
    };
  });
}

const PLATFORM_NAMES: Record<string, string> = {
  TERRA: 'Terra', AQUA: 'Aqua', SNPP: 'Suomi NPP', NOAA20: 'NOAA-20', NOAA21: 'NOAA-21'
};

/** Open the Export modal dialog with reactive localized title and close action. */
export function openExportPopup(popup: PopupService, i18n: I18nService): void {
  popup.open({
    id: 'data-io',
    title: computed(() => i18n.t().exportPopupTitle),
    component: DataPopupComponent,
    size: 'md',
    actions: [{ label: computed(() => i18n.t().close), variant: 'default' }]
  });
}
