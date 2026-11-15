import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule, Monitor, Sun, Moon } from 'lucide-angular';
import { PopupService } from '@kmd/design-system';
import { I18nService } from '../../core/i18n/i18n.service';
import { ThemePref, ThemePrefService } from '../../core/services/theme-pref.service';
import { AreaUnitPref, DateFormatPref, Lang } from '../../core/i18n/i18n.types';
import { formatLocaleDate } from '../../core/pipes/locale-date.pipe';

@Component({
  selector: 'app-settings-popup',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './settings-popup.component.html',
  styleUrl: './settings-popup.component.scss'
})
export class SettingsPopupComponent {
  readonly i18n = inject(I18nService);
  readonly themePref = inject(ThemePrefService);

  readonly themes = computed<{ id: ThemePref; icon: typeof Monitor; label: string }[]>(() => {
    const t = this.i18n.t();
    return [
      { id: 'auto', icon: Monitor, label: t.themeAuto },
      { id: 'light', icon: Sun, label: t.themeLight },
      { id: 'dark', icon: Moon, label: t.themeDark }
    ];
  });

  readonly languages: { id: Lang; label: string }[] = [
    { id: 'en', label: 'English' },
    { id: 'pl', label: 'Polski' }
  ];

  readonly dateFormats = computed<{ id: DateFormatPref; badge: string; label: string }[]>(() => [
    {
      id: 'auto',
      badge: formatLocaleDate('2026-11-14', 'full', this.i18n.autoDateLocale()),
      label: this.i18n.t().dateFormatAuto
    },
    { id: 'dmy-dot', badge: '14.11.2026', label: 'DD.MM.YYYY' },
    { id: 'dmy-slash', badge: '14/11/2026', label: 'DD/MM/YYYY' },
    { id: 'mdy-slash', badge: '11/14/2026', label: 'MM/DD/YYYY' },
    { id: 'iso', badge: '2026-11-14', label: 'YYYY-MM-DD' }
  ]);

  readonly areaUnits = computed<{ id: AreaUnitPref; badge: string; label: string }[]>(() => {
    const t = this.i18n.t();
    const autoBadge = this.i18n.autoAreaUnit() === 'mi2' ? 'mi²' : 'km²';
    return [
      { id: 'auto', badge: autoBadge, label: t.areaUnitAuto },
      { id: 'km2', badge: 'km²', label: t.areaUnitKm2 },
      { id: 'm2', badge: 'm²', label: t.areaUnitM2 },
      { id: 'ha', badge: 'ha', label: t.areaUnitHa },
      { id: 'mi2', badge: 'mi²', label: t.areaUnitMi2 }
    ];
  });

  selectTheme(pref: ThemePref): void {
    this.themePref.setPref(pref);
  }

  selectLang(lang: Lang): void {
    this.i18n.setLang(lang);
  }

  selectDateFormat(pref: DateFormatPref): void {
    this.i18n.setDateFormatPref(pref);
  }

  selectAreaUnit(pref: AreaUnitPref): void {
    this.i18n.setAreaUnitPref(pref);
  }
}

/** Open the Settings popup modal matching kmd-labs/el-nino. */
export function openSettingsPopup(popup: PopupService, i18n: I18nService): void {
  popup.open({
    id: 'settings',
    title: computed(() => i18n.t().settingsTitle),
    component: SettingsPopupComponent,
    size: 'sm',
    actions: [{ label: computed(() => i18n.t().close), variant: 'default' }]
  });
}
