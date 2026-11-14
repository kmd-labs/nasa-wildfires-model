import { Injectable, computed, effect, signal } from '@angular/core';
import { AreaUnitPref, DateFormatPref, Dict, Lang } from './i18n.types';
import { EN } from './en';
import { PL } from './pl';

const DICTS: Record<Lang, Dict> = { en: EN, pl: PL };
const STORAGE_KEY = 'nasa-wildfires-model.lang';
const DATE_FORMAT_KEY = 'nasa-wildfires-model.date-format';
const AREA_UNIT_KEY = 'nasa-wildfires-model.area-unit';
const SQ_METERS_PER_SQ_MILE = 2_589_988.110336;
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);
const IMPERIAL_TZ_EXACT = new Set([
  'Pacific/Honolulu',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'America/Detroit',
  'America/Boise',
  'America/Juneau',
  'America/Sitka',
  'America/Yakutat',
  'America/Nome',
  'America/Adak',
  'America/Metlakatla',
  'America/Menominee',
  'Africa/Monrovia',
  'Asia/Yangon',
  'Asia/Rangoon'
]);
const IMPERIAL_TZ_PREFIXES = ['US/', 'America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/'];
const DATE_FORMAT_LOCALES: Record<Exclude<DateFormatPref, 'auto'>, string> = {
  'dmy-dot': 'pl-PL',
  'dmy-slash': 'en-GB',
  'mdy-slash': 'en-US',
  iso: 'sv-SE'
};

/**
 * Manages UI language and localized texts.
 * Resolves initial language from localStorage ('nasa-wildfires-model.lang') or Navigator API,
 * falling back to 'en', and persists selection to localStorage.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly dicts = DICTS;
  readonly langs: Lang[] = ['en', 'pl'];
  readonly lang = signal<Lang>(this.resolveInitialLang());
  readonly dateFormatPref = signal<DateFormatPref>(this.resolveInitialDateFormat());
  readonly areaUnitPref = signal<AreaUnitPref>(this.resolveInitialAreaUnit());
  readonly t = computed(() => DICTS[this.lang()]);
  readonly autoDateLocale = computed<string>(() => {
    const currentLang = this.lang();
    const fallback = this.t().locale;
    if (typeof navigator === 'undefined') {
      return fallback;
    }
    const candidates = [
      ...(Array.isArray(navigator.languages) ? navigator.languages : []),
      navigator.language
    ].filter((c): c is string => Boolean(c));

    const regional = candidates.find(candidate => {
      const norm = candidate.trim().toLowerCase();
      return norm.startsWith(`${currentLang}-`) && norm.length > currentLang.length + 1;
    });
    return regional ?? fallback;
  });
  readonly dateLocale = computed<string>(() => {
    const pref = this.dateFormatPref();
    return pref === 'auto' ? this.autoDateLocale() : DATE_FORMAT_LOCALES[pref];
  });

  readonly autoAreaUnit = computed<Exclude<AreaUnitPref, 'auto'>>(() => {
    if (this.lang() === 'pl') {
      return 'km2';
    }
    const tz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' : '';
    if (tz) {
      const isImperialTz =
        IMPERIAL_TZ_EXACT.has(tz) || IMPERIAL_TZ_PREFIXES.some(prefix => tz.startsWith(prefix));
      return isImperialTz ? 'mi2' : 'km2';
    }
    const primary = typeof navigator !== 'undefined'
      ? (navigator.languages?.[0] || navigator.language || this.autoDateLocale())
      : this.autoDateLocale();
    const parts = primary.split(/[-_]/);
    const region = parts.length > 1 ? parts[1].toUpperCase() : '';
    return IMPERIAL_REGIONS.has(region) ? 'mi2' : 'km2';
  });

  readonly resolvedAreaUnit = computed<Exclude<AreaUnitPref, 'auto'>>(() => {
    const pref = this.areaUnitPref();
    return pref === 'auto' ? this.autoAreaUnit() : pref;
  });

  constructor() {
    effect(() => {
      const currentLang = this.lang();
      const d = this.t();
      if (typeof document !== 'undefined') {
        document.documentElement.lang = d.htmlLang;
        document.title = d.docTitle;
      }
      this.persistLang(currentLang);
    });
  }

  setLang(lang: Lang) {
    this.lang.set(lang);
  }

  setDateFormatPref(pref: DateFormatPref) {
    this.dateFormatPref.set(pref);
    try {
      localStorage.setItem(DATE_FORMAT_KEY, pref);
    } catch {
      // localStorage unavailable
    }
  }

  setAreaUnitPref(pref: AreaUnitPref) {
    this.areaUnitPref.set(pref);
    try {
      localStorage.setItem(AREA_UNIT_KEY, pref);
    } catch {
      // localStorage unavailable
    }
  }

  /** Format area (given in square meters) using the active unit & locale settings. */
  formatArea(m2: number, compactLarge = true): string {
    if (!Number.isFinite(m2) || m2 <= 0) return '0 m²';
    const locale = this.dateLocale();
    const unit = this.resolvedAreaUnit();

    if (unit === 'm2' || (unit === 'km2' && m2 < 10_000)) {
      const useCompact = compactLarge && m2 >= 1_000_000;
      const fmt = new Intl.NumberFormat(locale, {
        notation: useCompact ? 'compact' : 'standard',
        maximumFractionDigits: useCompact ? 1 : 0
      });
      return `${fmt.format(Math.round(m2))} m²`;
    }

    if (unit === 'mi2') {
      const mi2 = m2 / SQ_METERS_PER_SQ_MILE;
      const fmt = new Intl.NumberFormat(locale, {
        maximumFractionDigits: mi2 < 10 ? 2 : 0
      });
      return `${fmt.format(mi2)} mi²`;
    }

    if (unit === 'ha') {
      const ha = m2 / 10_000;
      const useCompact = compactLarge && ha >= 1_000_000;
      const fmt = new Intl.NumberFormat(locale, {
        notation: useCompact ? 'compact' : 'standard',
        maximumFractionDigits: useCompact ? 1 : ha < 10 ? 2 : 0
      });
      return `${fmt.format(ha)} ha`;
    }

    const km2 = m2 / 1_000_000;
    const fmt = new Intl.NumberFormat(locale, {
      maximumFractionDigits: km2 < 10 ? 2 : 0
    });
    return `${fmt.format(km2)} km²`;
  }

  /** Full-precision square meters readout for tooltips. */
  formatSquareMetersExact(m2: number): string {
    if (!Number.isFinite(m2) || m2 <= 0) return '0 m²';
    return `${new Intl.NumberFormat(this.dateLocale(), { maximumFractionDigits: 0 }).format(Math.round(m2))} m²`;
  }

  private resolveInitialAreaUnit(): AreaUnitPref {
    try {
      const stored = localStorage.getItem(AREA_UNIT_KEY);
      if (stored === 'auto' || stored === 'km2' || stored === 'm2' || stored === 'ha' || stored === 'mi2') {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return 'auto';
  }

  private resolveInitialDateFormat(): DateFormatPref {
    try {
      const stored = localStorage.getItem(DATE_FORMAT_KEY);
      if (stored === 'auto' || stored === 'dmy-dot' || stored === 'dmy-slash' || stored === 'mdy-slash' || stored === 'iso') {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return 'auto';
  }

  private resolveInitialLang(): Lang {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (this.isSupportedLang(stored)) {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }

    if (typeof navigator !== 'undefined') {
      const candidates = [
        ...(Array.isArray(navigator.languages) ? navigator.languages : []),
        navigator.language
      ].filter(Boolean);

      for (const candidate of candidates) {
        const prefix = candidate.slice(0, 2).toLowerCase();
        if (this.isSupportedLang(prefix)) {
          return prefix;
        }
      }
    }

    return 'en';
  }

  private isSupportedLang(val: string | null | undefined): val is Lang {
    return val === 'en' || val === 'pl';
  }

  private persistLang(lang: Lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // localStorage unavailable
    }
  }
}
