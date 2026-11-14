import { Pipe, PipeTransform, inject } from '@angular/core';
import { I18nService } from '../i18n/i18n.service';

export type LocaleDateFormat = 'full' | 'monthYear' | 'medium';

/** Format an ISO date/month string, timestamp, or Date using Intl.DateTimeFormat in UTC. */
export function formatLocaleDate(
  value: Date | string | number | null | undefined,
  format: LocaleDateFormat = 'full',
  locale = 'en-US'
): string {
  if (value == null || value === '') return '';
  let d: Date;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const iso = /^\d{4}-\d{2}$/.test(trimmed)
      ? `${trimmed}-01T12:00:00Z`
      : trimmed.includes('T')
        ? trimmed
        : `${trimmed}T12:00:00Z`;
    d = new Date(iso);
  } else if (typeof value === 'number') {
    d = new Date(value);
  } else {
    d = value;
  }

  if (Number.isNaN(d.getTime())) return '';

  if (format === 'monthYear') {
    return new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(d);
  }

  if (format === 'medium') {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(d);
  }

  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(d);
}

@Pipe({
  name: 'localeDate',
  standalone: true,
  pure: false
})
export class LocaleDatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(
    value: Date | string | number | null | undefined,
    format: LocaleDateFormat = 'full',
    localeOverride?: string
  ): string {
    const locale = localeOverride ?? this.i18n.dateLocale() ?? this.i18n.t().locale ?? 'en-US';
    return formatLocaleDate(value, format, locale);
  }
}
