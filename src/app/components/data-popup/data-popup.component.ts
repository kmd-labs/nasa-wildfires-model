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
}

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
