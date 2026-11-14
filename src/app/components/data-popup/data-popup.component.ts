import { Component, ElementRef, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  LucideAngularModule,
  Upload,
  Download,
  FileSpreadsheet,
  FileJson,
  Image,
  RotateCcw
} from 'lucide-angular';
import { ButtonComponent } from '@kmd/design-system';
import { I18nService } from '../../core/i18n/i18n.service';
import { WildfireStateService } from '../../core/services/wildfire-state.service';
import { WildfireDataService } from '../../core/services/wildfire-data.service';
import { HotspotAnalyticsService } from '../../core/services/hotspot-analytics.service';

@Component({
  selector: 'app-data-popup',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, ButtonComponent],
  templateUrl: './data-popup.component.html',
  styleUrl: './data-popup.component.scss'
})
export class DataPopupComponent {
  @ViewChild('fileInputRef') fileInputRef?: ElementRef<HTMLInputElement>;

  readonly i18n = inject(I18nService);
  readonly state = inject(WildfireStateService);
  readonly data = inject(WildfireDataService);
  readonly analytics = inject(HotspotAnalyticsService);

  readonly importSuccessCount = signal<number | null>(null);
  readonly isDragOver = signal<boolean>(false);

  readonly uploadIcon = Upload;
  readonly downloadIcon = Download;
  readonly csvIcon = FileSpreadsheet;
  readonly jsonIcon = FileJson;
  readonly imageIcon = Image;
  readonly resetIcon = RotateCcw;

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
