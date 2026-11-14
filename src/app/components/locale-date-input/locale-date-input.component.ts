import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule, Calendar } from 'lucide-angular';
import { I18nService } from '../../core/i18n/i18n.service';
import { formatLocaleDate } from '../../core/pipes/locale-date.pipe';

const SAMPLE_UTC_DATE = new Date(Date.UTC(2026, 10, 14, 12, 0, 0));

function isMonthBeforeDay(locale: string): boolean {
  const parts = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC'
  }).formatToParts(SAMPLE_UTC_DATE);
  const monthIdx = parts.findIndex(p => p.type === 'month');
  const dayIdx = parts.findIndex(p => p.type === 'day');
  return monthIdx !== -1 && dayIdx !== -1 && monthIdx < dayIdx;
}

function placeholderForLocale(locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC'
  }).formatToParts(SAMPLE_UTC_DATE);
  return parts
    .map(p => {
      if (p.type === 'day') return 'DD';
      if (p.type === 'month') return 'MM';
      if (p.type === 'year') return 'YYYY';
      return p.value;
    })
    .join('');
}

function toValidIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalizedDateInput(raw: string, locale: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(trimmed);
  if (ymd) {
    return toValidIso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }

  const dmyDot = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (dmyDot) {
    return toValidIso(Number(dmyDot[3]), Number(dmyDot[2]), Number(dmyDot[1]));
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    const [month, day] = isMonthBeforeDay(locale) ? [first, second] : [second, first];
    return toValidIso(year, month, day);
  }

  return null;
}

/**
 * Locale-formatted date picker input synchronized with I18nService.dateLocale(),
 * supporting both direct keyboard entry and the native browser calendar popup.
 */
@Component({
  selector: 'app-locale-date-input',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './locale-date-input.component.html',
  styleUrl: './locale-date-input.component.scss'
})
export class LocaleDateInputComponent {
  readonly i18n = inject(I18nService);
  readonly calendarIcon = Calendar;

  readonly label = input<string>('');
  readonly value = input<string>('');
  readonly min = input<string>('');
  readonly max = input<string>('');
  readonly missing = input<boolean>(false);
  readonly disabled = input<boolean>(false);

  readonly valueChange = output<string>();

  readonly editing = signal(false);
  readonly draftText = signal('');

  readonly formattedValue = computed(() =>
    formatLocaleDate(this.value(), 'full', this.i18n.dateLocale())
  );

  readonly placeholderText = computed(() => placeholderForLocale(this.i18n.dateLocale()));

  readonly displayValue = computed(() =>
    this.editing() ? this.draftText() : this.formattedValue()
  );

  onFocus(): void {
    this.draftText.set(this.formattedValue());
    this.editing.set(true);
  }

  onTextInput(raw: string): void {
    this.draftText.set(raw);
  }

  commitText(inputEl?: HTMLInputElement): void {
    if (!this.editing()) return;
    const parsed = parseLocalizedDateInput(this.draftText(), this.i18n.dateLocale());
    this.editing.set(false);
    if (parsed === null) {
      if (inputEl) inputEl.value = this.formattedValue();
      return;
    }
    const clamped = this.clampIso(parsed);
    if (clamped !== this.value()) {
      this.valueChange.emit(clamped);
    }
    if (inputEl) {
      inputEl.value = formatLocaleDate(clamped, 'full', this.i18n.dateLocale());
    }
  }

  onNativeChange(iso: string): void {
    this.editing.set(false);
    const clamped = this.clampIso(iso);
    if (clamped !== this.value()) {
      this.valueChange.emit(clamped);
    }
  }

  openPicker(nativeInput: HTMLInputElement): void {
    if (this.disabled()) return;
    try {
      if (typeof nativeInput.showPicker === 'function') {
        nativeInput.showPicker();
        return;
      }
    } catch {
      // Fallback for browsers rejecting showPicker()
    }
    nativeInput.focus();
    nativeInput.click();
  }

  private clampIso(iso: string): string {
    if (!iso) return '';
    const min = this.min();
    const max = this.max();
    if (min && iso < min) return min;
    if (max && iso > max) return max;
    return iso;
  }
}
