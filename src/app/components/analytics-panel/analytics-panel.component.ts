import { Component, ElementRef, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  LucideAngularModule,
  Calendar,
  BarChart3,
  Upload,
  Download,
  FileSpreadsheet,
  FileJson,
  Image,
  Maximize2,
  Minimize2,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Palette,
  Flame,
  BoxSelect,
  Compass,
  SlidersHorizontal
} from 'lucide-angular';
import { ButtonComponent, DropdownComponent, DropdownOption } from '@kmd/design-system';
import { I18nService } from '../../core/i18n/i18n.service';
import { WildfireStateService } from '../../core/services/wildfire-state.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';
import { ColorRampService } from '../../core/services/color-ramp.service';
import {
  BoundingBox,
  BurningCalendarCell,
  ColorRampId,
  YearlyComparisonPoint
} from '../../core/models/wildfire.model';

type AnalyticsTab = 'calendar' | 'history' | 'export';

@Component({
  selector: 'app-analytics-panel',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, ButtonComponent, DropdownComponent],
  templateUrl: './analytics-panel.component.html',
  styleUrl: './analytics-panel.component.scss'
})
export class AnalyticsPanelComponent {
  @ViewChild('fileInputRef') fileInputRef?: ElementRef<HTMLInputElement>;

  readonly i18n = inject(I18nService);
  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly analytics = inject(HotspotAnalyticsService);
  readonly ramps = inject(ColorRampService);
  readonly Math = Math;

  readonly activeTab = signal<AnalyticsTab>('calendar');
  readonly expanded = signal<boolean>(false);
  readonly showForm = signal<boolean>(true);
  readonly showCoordsInputs = signal<boolean>(false);
  readonly hoveredCell = signal<BurningCalendarCell | null>(null);
  readonly hoveredYear = signal<YearlyComparisonPoint | null>(null);
  readonly importSuccessCount = signal<number | null>(null);
  readonly isDragOver = signal<boolean>(false);

  readonly draftW = signal<number>(-9.6);
  readonly draftS = signal<number>(36.0);
  readonly draftE = signal<number>(3.4);
  readonly draftN = signal<number>(43.8);

  // Icons
  readonly calendarIcon = Calendar;
  readonly chartIcon = BarChart3;
  readonly uploadIcon = Upload;
  readonly downloadIcon = Download;
  readonly csvIcon = FileSpreadsheet;
  readonly jsonIcon = FileJson;
  readonly imageIcon = Image;
  readonly expandIcon = Maximize2;
  readonly collapseIcon = Minimize2;
  readonly chevronLeftIcon = ChevronLeft;
  readonly chevronDownIcon = ChevronDown;
  readonly chevronUpIcon = ChevronUp;
  readonly resetIcon = RotateCcw;
  readonly paletteIcon = Palette;
  readonly flameIcon = Flame;
  readonly boxSelectIcon = BoxSelect;
  readonly compassIcon = Compass;
  readonly slidersIcon = SlidersHorizontal;

  constructor() {
    effect(() => {
      const [w, s, e, n] = this.state.regionBbox();
      this.draftW.set(w);
      this.draftS.set(s);
      this.draftE.set(e);
      this.draftN.set(n);
    });
  }

  readonly aoiOptions = computed<DropdownOption<string>[]>(() => {
    const t = this.i18n.t();
    const list: DropdownOption<string>[] = [
      { value: 'iberia_all', label: t.regionIberiaAll, badge: 'ALL' }
    ];
    if (this.state.selectedAoiId() === 'custom') {
      list.push({ value: 'custom', label: t.regionCustomBbox, badge: 'BOX' });
    }
    for (const a of this.data.aois()) {
      list.push({
        value: a.aoiId,
        label: a.name,
        badge: String(a.year)
      });
    }
    return list;
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
    if ([w, s, e, n].every(Number.isFinite)) {
      const bbox: BoundingBox = [w, s, e, n];
      this.state.setCustomBbox(bbox, true);
    }
  }

  applyDatePreset(start: string, end: string) {
    this.state.setDateRange(start, end);
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

  triggerFilePicker() {
    this.fileInputRef?.nativeElement.click();
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.readAndImportFile(file);
    input.value = '';
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragOver.set(true);
  }

  onDragLeave() {
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.isDragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      this.readAndImportFile(file);
    }
  }

  private readAndImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const res = this.data.importHotspotFile(file.name, text);
      if (res.ok) {
        this.importSuccessCount.set(res.count);
        if (res.minDate && res.maxDate) {
          this.state.setDateRange(res.minDate, res.maxDate);
        }
        if (res.bbox) {
          this.state.setCustomBbox(res.bbox, true);
        }
      } else {
        this.importSuccessCount.set(null);
      }
    };
    reader.readAsText(file);
  }

  resetDataset() {
    this.importSuccessCount.set(null);
    this.data.resetToDefaultHotspots();
    this.state.resetRegionAndDates();
  }
}
