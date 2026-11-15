import { Component, ElementRef, HostListener, ViewChild, computed, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  LucideAngularModule,
  BarChart3,
  Maximize2,
  Minimize2,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Palette,
  BoxSelect,
  SlidersHorizontal,
  Layers,
  CheckCircle2,
  CircleDashed,
  Compass,
  Check,
  Loader2,
  Globe,
  Search,
  Download,
  Calendar,
  X
} from 'lucide-angular';
import {
  ButtonComponent,
  DateRangeSliderComponent,
  DropdownComponent,
  DropdownOption,
  PopupService,
  SwitcherComponent,
  SwitcherOption,
  TooltipDirective,
  TooltipService
} from '@kmd/design-system';
import { ThemeService } from '@kmd/design-system/services/theme.service';
import { openExportPopup } from '../data-popup/data-popup.component';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_PREFILL_BBOX, WildfireStateService } from '../../core/services/wildfire-state.service';
import { USER_LOCATION_PIN_COLOR } from '../../core/utils/location-pin';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { HotspotAnalyticsService, BurningCalendarModel } from '../../core/services/hotspot-analytics.service';
import { ColorRampService } from '../../core/services/color-ramp.service';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { LocaleDateInputComponent } from '../locale-date-input/locale-date-input.component';
import {
  BurningCalendarCell,
  CalendarGranularity,
  ChartGranularity,
  ChartSeriesPoint,
  ColorRampId,
  DatasetSelectionMode,
  PredefinedCountry
} from '../../core/models/wildfire.model';

@Component({
  selector: 'app-analytics-panel',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, ButtonComponent, DateRangeSliderComponent, DropdownComponent, SwitcherComponent, TooltipDirective, LocaleDatePipe, LocaleDateInputComponent],
  templateUrl: './analytics-panel.component.html',
  styleUrl: './analytics-panel.component.scss'
})
export class AnalyticsPanelComponent {
  @ViewChild('scrollContainer') scrollContainerRef?: ElementRef<HTMLDivElement>;
  @ViewChild('regionAnchor') regionAnchorRef?: ElementRef<HTMLElement>;
  @ViewChild('dataAnchor') dataAnchorRef?: ElementRef<HTMLElement>;
  @ViewChild('layersAnchor') layersAnchorRef?: ElementRef<HTMLElement>;
  @ViewChild('analysisAnchor') analysisAnchorRef?: ElementRef<HTMLElement>;
  @ViewChild('areaPicker') areaPickerRef?: ElementRef<HTMLElement>;

  readonly maxSelectableDate = new Date().toISOString().slice(0, 10);
  readonly i18n = inject(I18nService);
  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly analytics = inject(HotspotAnalyticsService);
  readonly ramps = inject(ColorRampService);
  private readonly theme = inject(ThemeService);
  private readonly popup = inject(PopupService);
  private readonly tooltipService = inject(TooltipService);
  readonly Math = Math;

  readonly expanded = this.state.isAnalyticsExpanded;
  readonly showForm = this.state.showRegionForm;
  readonly showDataSection = this.state.showDataSection;
  readonly showLayersSection = this.state.showLayersSection;
  readonly showAnalysisSection = this.state.showAnalysisSection;
  readonly hoveredCell = signal<BurningCalendarCell | null>(null);
  readonly hoveredChartPoint = signal<ChartSeriesPoint | null>(null);

  readonly draftW = signal<string>('');
  readonly draftS = signal<string>('');
  readonly draftE = signal<string>('');
  readonly draftN = signal<string>('');
  readonly coordError = signal<boolean>(false);
  private editingCoordInputs = false;
  readonly areaDropdownOpen = signal<boolean>(false);
  readonly areaSearchQuery = signal<string>('');
  readonly selectedCountryCode = signal<string | null>('__IBERIA__');
  readonly openDailyYears = signal<Set<number>>(new Set());
  private initializedDailyYearKey = '';

  // Icons
  readonly chartIcon = BarChart3;
  readonly expandIcon = Maximize2;
  readonly collapseIcon = Minimize2;
  readonly chevronLeftIcon = ChevronLeft;
  readonly chevronDownIcon = ChevronDown;
  readonly chevronUpIcon = ChevronUp;
  readonly resetIcon = RotateCcw;
  readonly paletteIcon = Palette;
  readonly boxSelectIcon = BoxSelect;
  readonly slidersIcon = SlidersHorizontal;
  readonly layersIcon = Layers;
  readonly checkCircleIcon = CheckCircle2;
  readonly circleDashedIcon = CircleDashed;
  readonly compassIcon = Compass;
  readonly checkIcon = Check;
  readonly loaderIcon = Loader2;
  readonly globeIcon = Globe;
  readonly searchIcon = Search;
  readonly downloadIcon = Download;
  readonly calendarIcon = Calendar;
  readonly closeIcon = X;

  constructor() {
    effect(() => {
      const draftPoly = this.state.draftPolygon();
      const b = this.state.regionBbox();
      if (this.editingCoordInputs) return;
      if (draftPoly && draftPoly.length >= 3) {
        let minW = 180;
        let minS = 85;
        let maxE = -180;
        let maxN = -85;
        for (const [lon, lat] of draftPoly) {
          if (lon < minW) minW = lon;
          if (lon > maxE) maxE = lon;
          if (lat < minS) minS = lat;
          if (lat > maxN) maxN = lat;
        }
        this.draftW.set(String(Number(minW.toFixed(2))));
        this.draftS.set(String(Number(minS.toFixed(2))));
        this.draftE.set(String(Number(maxE.toFixed(2))));
        this.draftN.set(String(Number(maxN.toFixed(2))));
      } else if (b) {
        this.draftW.set(String(b[0]));
        this.draftS.set(String(b[1]));
        this.draftE.set(String(b[2]));
        this.draftN.set(String(b[3]));
      } else {
        this.draftW.set('');
        this.draftS.set('');
        this.draftE.set('');
        this.draftN.set('');
      }
      this.coordError.set(false);
    });

    effect(() => {
      const yearModels = this.analytics.burningCalendarsDailyByYear();
      if (yearModels.length === 0) {
        this.initializedDailyYearKey = '';
        return;
      }
      const yearKey = yearModels.map(m => m.year).join(',');
      if (yearKey === this.initializedDailyYearKey) return;
      this.initializedDailyYearKey = yearKey;
      const validYears = new Set(yearModels.map(m => m.year));
      const cur = untracked(() => this.openDailyYears());
      const stillValid = [...cur].filter(y => validYears.has(y));
      if (stillValid.length > 0) return;
      const defaultYear = yearModels[yearModels.length - 1].year;
      this.openDailyYears.set(new Set([defaultYear]));
    });
  }

  readonly syncStatusText = computed<string>(() => {
    const t = this.i18n.t();
    const status = this.data.backendStatus();
    if (status === 'loading') return t.backendLoadingLabel;
    if (status === 'downloading') {
      const prog = this.data.backendProgress();
      if (prog && prog.total > 0 && prog.done >= prog.total) {
        return t.backendAnalyzingLabel;
      }
      return prog && prog.total > 0
        ? `${t.backendDownloadingLabel} (${prog.done}/${prog.total} ${t.backendChunksLabel})`
        : t.backendDownloadingLabel;
    }
    return '';
  });

  readonly layerItems = computed(() => {
    const t = this.i18n.t();
    return [
      {
        id: 'hotspots',
        label: t.layerHotspots,
        swatch: '#ea580c',
        checked: this.state.showHotspotsOnGlobe(),
        setChecked: (v: boolean) => this.state.showHotspotsOnGlobe.set(v)
      },
      {
        id: 'bbox',
        label: t.layerRegionBbox,
        swatch: '#d37400',
        checked: this.state.showRegionBbox(),
        setChecked: (v: boolean) => this.state.showRegionBbox.set(v)
      },
      {
        id: 'ortho',
        label: t.layerLandOrtho,
        swatch: '#2f6f4e',
        checked: this.state.showLandOrtho(),
        setChecked: (v: boolean) => this.state.showLandOrtho.set(v)
      },
      ...(this.state.showLandOrtho()
        ? [
            {
              id: 'borders',
              label: t.layerBorders,
              swatch: '#cbd5e1',
              checked: this.state.showBorders(),
              setChecked: (v: boolean) => this.state.showBorders.set(v)
            }
          ]
        : []),
      {
        id: 'userLocation',
        label: t.layerUserLocation,
        swatch: USER_LOCATION_PIN_COLOR,
        checked: this.state.showUserLocation(),
        setChecked: (v: boolean) => this.state.setUserLocationEnabled(v)
      }
    ];
  });

  onLayerToggle(
    item: { id: string; setChecked: (v: boolean) => void },
    inputEl: HTMLInputElement
  ): void {
    const next = inputEl.checked;
    item.setChecked(next);
    if (item.id === 'userLocation') {
      inputEl.checked = this.state.showUserLocation();
    }
  }

  readonly activeLayersCount = computed<number>(
    () => this.layerItems().filter(item => item.checked).length
  );

  readonly datasetOptions = computed<SwitcherOption<DatasetSelectionMode>[]>(() => {
    const t = this.i18n.t();
    const viirsOk = this.state.isViirsAvailable();
    const bothRequired = this.state.requiresBothSensors();
    return [
      {
        value: 'VIIRS',
        label: t.datasetViirsBtn,
        disabled: bothRequired || !viirsOk,
        tooltip: bothRequired
          ? t.bothSensorsRequiredTooltip
          : !viirsOk
            ? t.viirsUnavailableTooltip
            : t.datasetViirsDesc
      },
      {
        value: 'MODIS',
        label: t.datasetModisBtn,
        disabled: bothRequired,
        tooltip: bothRequired ? t.bothSensorsRequiredTooltip : t.datasetModisDesc
      },
      {
        value: 'BOTH',
        label: t.datasetBothBtn,
        disabled: !viirsOk,
        tooltip: !viirsOk
          ? t.viirsUnavailableTooltip
          : bothRequired
            ? t.bothSensorsRequiredTooltip
            : t.datasetBothDesc
      }
    ];
  });

  readonly activeDatasetDisplayLabel = computed<string>(() => {
    const t = this.i18n.t();
    const dataset = this.state.activeDataset();
    if (dataset === 'BOTH') {
      return this.state.requiresBothSensors() ? t.datasetMixedLabel : t.datasetBothBtn;
    }
    return dataset === 'VIIRS' ? t.datasetViirsBtn : t.datasetModisBtn;
  });

  onDatasetOptionClick(opt: SwitcherOption<DatasetSelectionMode>, event: MouseEvent): void {
    if (opt.disabled) {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget as HTMLElement | null;
      if (target && opt.tooltip) {
        const rect = target.getBoundingClientRect();
        this.tooltipService.show(
          opt.tooltip,
          rect.left + rect.width / 2,
          rect.bottom,
          'bottom',
          2800
        );
      }
      return;
    }
    this.state.setDataset(opt.value);
  }

  readonly calendarModeOptions = computed<SwitcherOption<CalendarGranularity>[]>(() => {
    const t = this.i18n.t();
    return [
      { value: 'monthly', label: t.calendarMonthly },
      { value: 'daily', label: t.calendarDaily }
    ];
  });

  readonly chartModeOptions = computed<SwitcherOption<ChartGranularity>[]>(() => {
    const t = this.i18n.t();
    return [
      { value: 'monthly', label: t.chartMonthly },
      { value: 'yearly', label: t.chartYearly }
    ];
  });

  readonly colorRampOptions = computed<DropdownOption<ColorRampId>[]>(() => {
    const t = this.i18n.t();
    return [
      { value: 'okabeIto', label: t.rampOkabeIto },
      { value: 'cividis', label: t.rampCividis },
      { value: 'viridis', label: t.rampViridis },
      { value: 'ylOrRd', label: t.rampYlOrRd }
    ];
  });

  readonly activeRampGradient = computed(() => this.ramps.getRamp(this.state.colorRamp()).cssGradient);

  readonly calendarSvgDims = computed(() => this.getCalendarSvgDims(this.analytics.burningCalendar()));

  getCalendarSvgDims(cal: BurningCalendarModel) {
    const rows = Math.max(1, cal.rowLabels.length);
    const cols = Math.max(1, cal.colLabels.length);
    const leftPad = 42;
    const topPad = 18;
    const width = 500;
    const cellW = (width - leftPad - 6) / cols;
    const cellH = cal.mode === 'daily' ? 17 : Math.max(11, Math.min(20, 210 / rows));
    const height = topPad + rows * cellH + 8;
    return { leftPad, topPad, width, height, cellW, cellH };
  }

  isDailyYearOpen(year: number): boolean {
    return this.openDailyYears().has(year);
  }

  toggleDailyYear(year: number): void {
    const next = new Set(this.openDailyYears());
    if (next.has(year)) {
      next.delete(year);
    } else {
      next.add(year);
    }
    this.openDailyYears.set(next);
  }

  readonly historyMaxVal = computed(() => {
    const list = this.analytics.chartSeries();
    return Math.max(1, ...list.map(y => Math.max(y.harmonizedCount, y.rawModisCount, y.avgCount)));
  });

  readonly anomalyMaxAbsZ = computed(() => {
    const list = this.analytics.chartSeries();
    return Math.max(1, ...list.map(y => Math.abs(y.anomalyZScore)));
  });

  private readonly regionDisplayNames = computed(() => {
    const lang = this.i18n.lang();
    try {
      return typeof Intl !== 'undefined' && 'DisplayNames' in Intl
        ? new Intl.DisplayNames([lang], { type: 'region' })
        : null;
    } catch {
      return null;
    }
  });

  readonly filteredCountries = computed<PredefinedCountry[]>(() => {
    const all = this.data.countries();
    const q = this.areaSearchQuery().trim().toLowerCase();
    if (!q) return all;
    return all.filter(c => {
      const loc = this.countryLabel(c).toLowerCase();
      return (
        loc.includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        (c.iso2?.toLowerCase().includes(q) ?? false)
      );
    });
  });

  readonly showIberiaOption = computed<boolean>(() => {
    const q = this.areaSearchQuery().trim().toLowerCase();
    if (!q) return true;
    const t = this.i18n.t();
    return (
      t.regionIberiaDefault.toLowerCase().includes(q) ||
      t.regionIberiaAll.toLowerCase().includes(q) ||
      'iberian peninsula'.includes(q) ||
      'iberia'.includes(q) ||
      'ibr'.includes(q)
    );
  });

  readonly activeRegionName = computed<string>(() => {
    const b = this.state.regionBbox();
    if (!b) return '';
    if (DEFAULT_PREFILL_BBOX.every((v, idx) => Math.abs(b[idx] - v) <= 0.02)) {
      return this.i18n.t().regionIberiaDefault;
    }
    const code = this.selectedCountryCode();
    if (code && code !== '__IBERIA__') {
      const found = this.data.countries().find(c => c.code === code);
      if (found && found.primaryBbox.every((v, idx) => Math.abs(b[idx] - v) <= 0.6)) {
        return `${this.countryLabel(found)} (${found.code})`;
      }
    }
    return '';
  });

  countryLabel(country: PredefinedCountry): string {
    if (country.iso2) {
      const localized = this.regionDisplayNames()?.of(country.iso2);
      if (localized) return localized;
    }
    return country.name;
  }

  toggleAreaDropdown(): void {
    this.areaDropdownOpen.update(v => !v);
  }

  chooseIberiaDefault(): void {
    this.selectedCountryCode.set('__IBERIA__');
    this.areaSearchQuery.set('');
    this.areaDropdownOpen.set(false);
    this.state.selectDefaultIberia();
  }

  chooseCountry(country: PredefinedCountry): void {
    this.selectedCountryCode.set(country.code);
    this.areaSearchQuery.set('');
    this.areaDropdownOpen.set(false);
    this.state.selectPredefinedCountry(country);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.areaDropdownOpen()) return;
    const target = event.target as Node | null;
    if (target && !this.areaPickerRef?.nativeElement.contains(target)) {
      this.areaDropdownOpen.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.areaDropdownOpen()) {
      this.areaDropdownOpen.set(false);
    }
  }

  onCoordFocusChange(editing: boolean): void {
    this.editingCoordInputs = editing;
  }

  onCoordInput(which: 'w' | 's' | 'e' | 'n', value: string) {
    if (which === 'w') this.draftW.set(value);
    else if (which === 's') this.draftS.set(value);
    else if (which === 'e') this.draftE.set(value);
    else this.draftN.set(value);

    const parseCoord = (raw: string): number | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : null;
    };

    const w = parseCoord(this.draftW());
    const s = parseCoord(this.draftS());
    const e = parseCoord(this.draftE());
    const n = parseCoord(this.draftN());
    const validCount = [w, s, e, n].filter((v): v is number => v !== null).length;

    if (validCount < 3) {
      this.coordError.set(false);
      return;
    }

    const clamp = (val: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, val));
    const inferSpan = (otherSpan: number) =>
      Number.isFinite(otherSpan) && otherSpan > 0 ? Math.min(8, Math.max(0.25, otherSpan * 0.75)) : 0.5;

    const lonSpan = w !== null && e !== null ? e - w : 0.6;
    const latSpan = s !== null && n !== null ? n - s : 0.6;

    const finalW = w ?? clamp(e! - inferSpan(latSpan), -180, 180);
    const finalE = e ?? clamp(w! + inferSpan(latSpan), -180, 180);
    const finalS = s ?? clamp(n! - inferSpan(lonSpan), -85, 85);
    const finalN = n ?? clamp(s! + inferSpan(lonSpan), -85, 85);

    if (finalW < finalE && finalS < finalN) {
      this.coordError.set(false);
      this.state.previewCoordBox([finalW, finalS, finalE, finalN]);
    } else if (validCount === 4) {
      this.coordError.set(true);
    }
  }

  onCoordEnter() {
    this.editingCoordInputs = false;
    this.state.recalculateSelection();
  }

  openExport(): void {
    openExportPopup(this.popup, this.i18n);
  }

  toggleSection(section: 'region' | 'data' | 'layers' | 'analysis'): void {
    let expanding = false;
    if (section === 'region') {
      expanding = !this.showForm();
      this.showForm.set(expanding);
    } else if (section === 'data') {
      expanding = !this.showDataSection();
      this.showDataSection.set(expanding);
    } else if (section === 'layers') {
      expanding = !this.showLayersSection();
      this.showLayersSection.set(expanding);
    } else {
      expanding = !this.showAnalysisSection();
      this.showAnalysisSection.set(expanding);
    }
    if (!expanding) return;

    requestAnimationFrame(() => {
      const container = this.scrollContainerRef?.nativeElement;
      const anchor =
        section === 'region'
          ? this.regionAnchorRef?.nativeElement
          : section === 'data'
            ? this.dataAnchorRef?.nativeElement
            : section === 'layers'
              ? this.layersAnchorRef?.nativeElement
              : this.analysisAnchorRef?.nativeElement;
      if (!container || !anchor) return;

      const stickyOffset = section === 'layers' ? 0 : section === 'region' ? 38 : section === 'data' ? 76 : 114;
      const targetTop = Math.max(0, anchor.offsetTop - stickyOffset);
      container.scrollTo({ top: targetTop, behavior: 'smooth' });
    });
  }

  cellFill(cell: BurningCalendarCell): string {
    this.theme.mode(); // Track active theme so Angular updates cell fills on switch
    if (!cell.inRange) {
      return cell.harmonizedCount > 0
        ? this.theme.getTokenColor('surface-muted-strong', '#dbe2ea')
        : this.theme.getTokenColor('surface-muted', '#f1f5f9');
    }
    if (cell.harmonizedCount <= 0) {
      return this.theme.getTokenColor('surface-muted', '#eef2f7');
    }
    return this.ramps.sampleHex(this.state.colorRamp(), cell.intensity);
  }

  cellOpacity(cell: BurningCalendarCell): number {
    if (!cell.inRange) return 0.4;
    return 1;
  }
}
