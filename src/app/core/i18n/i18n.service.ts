import { Injectable, computed, effect, signal } from '@angular/core';
import { DateFormatPref, Dict, Lang } from './i18n.types';
import { EN } from './en';
import { PL } from './pl';

const DICTS: Record<Lang, Dict> = { en: EN, pl: PL };
const STORAGE_KEY = 'nasa-wildfires-model.lang';
const DATE_FORMAT_KEY = 'nasa-wildfires-model.date-format';
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
