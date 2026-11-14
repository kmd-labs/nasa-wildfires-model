import { Component, computed, effect, inject, signal } from '@angular/core';
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
  Compass
} from 'lucide-angular';
import { ButtonComponent, DropdownComponent, DropdownOption } from '@kmd/design-system';
import { I18nService } from '../../core/i18n/i18n.service';
import { WildfireStateService } from '../../core/services/wildfire-state.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';
import { ColorRampService } from '../../core/services/color-ramp.service';
import {
  BurningCalendarCell,
  ColorRampId,
  YearlyComparisonPoint
} from '../../core/models/wildfire.model';

@Component({
  selector: 'app-analytics-panel',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, ButtonComponent, DropdownComponent],
  templateUrl: './analytics-panel.component.html',
  styleUrl: './analytics-panel.component.scss'
})
export class AnalyticsPanelComponent {
  readonly i18n = inject(I18nService);
  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly analytics = inject(HotspotAnalyticsService);
  readonly ramps = inject(ColorRampService);
  readonly Math = Math;

  readonly expanded = this.state.isAnalyticsExpanded;
  readonly showForm = this.state.showRegionForm;
  readonly showCoordsInputs = this.state.showCoordsInputs;
  readonly showLayersSection = this.state.showLayersSection;
  readonly showAnalysisSection = this.state.showAnalysisSection;
  readonly hoveredCell = signal<BurningCalendarCell | null>(null);
  readonly hoveredYear = signal<YearlyComparisonPoint | null>(null);

  readonly draftW = signal<string>('');
  readonly draftS = signal<string>('');
  readonly draftE = signal<string>('');
  readonly draftN = signal<string>('');
  readonly coordError = signal<boolean>(false);

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

  constructor() {
    effect(() => {
      const b = this.state.regionBbox();
      if (b) {
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
  }

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
      }
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

  readonly calendarSvgDims = computed(() => {
    const cal = this.analytics.burningCalendar();
    const rows = Math.max(1, cal.rowLabels.length);
    const cols = Math.max(1, cal.colLabels.length);
    const leftPad = 42;
    const topPad = 18;
    const width = 500;
    const cellW = (width - leftPad - 6) / cols;
    const cellH = cal.mode === 'daily' ? 17 : Math.max(11, Math.min(20, 210 / rows));
    const height = topPad + rows * cellH + 8;
    return { leftPad, topPad, width, height, cellW, cellH };
  });

  readonly historyMaxVal = computed(() => {
    const list = this.analytics.yearlyComparison();
    return Math.max(1, ...list.map(y => Math.max(y.harmonizedCount, y.rawModisCount, y.multiYearAvgCount)));
  });

  readonly anomalyMaxAbsZ = computed(() => {
    const list = this.analytics.yearlyComparison();
    return Math.max(2, ...list.map(y => Math.abs(y.anomalyZScore)));
  });

  applyDraftCoords() {
    const w = Number(this.draftW());
    const s = Number(this.draftS());
    const e = Number(this.draftE());
    const n = Number(this.draftN());
    if (
      this.draftW().trim() === '' ||
      this.draftS().trim() === '' ||
      this.draftE().trim() === '' ||
      this.draftN().trim() === '' ||
      !Number.isFinite(w) ||
      !Number.isFinite(s) ||
      !Number.isFinite(e) ||
      !Number.isFinite(n) ||
      w >= e ||
      s >= n
    ) {
      this.coordError.set(true);
      return;
    }
    this.coordError.set(false);
    this.state.setCustomBbox([w, s, e, n], true);
  }

  cellFill(cell: BurningCalendarCell): string {
    if (!cell.inRange) {
      return cell.harmonizedCount > 0 ? '#dbe2ea' : '#f1f5f9';
    }
    if (cell.harmonizedCount <= 0) return '#eef2f7';
    return this.ramps.sampleHex(this.state.colorRamp(), cell.intensity);
  }

  cellOpacity(cell: BurningCalendarCell): number {
    if (!cell.inRange) return 0.4;
    return 1;
  }
}
