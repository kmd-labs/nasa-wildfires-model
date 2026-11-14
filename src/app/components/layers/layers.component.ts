import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule, Layers, RotateCcw, X } from 'lucide-angular';
import { ButtonComponent, ToggleComponent } from '@kmd/design-system';
import { I18nService } from '../../core/i18n/i18n.service';
import { WildfireStateService } from '../../core/services/wildfire-state.service';

interface LayerToggleItem {
  id: string;
  label: string;
  swatch: string;
  checked: boolean;
  setChecked: (value: boolean) => void;
}

interface LayerSection {
  id: string;
  title: string;
  items: LayerToggleItem[];
}

@Component({
  selector: 'app-layers',
  standalone: true,
  imports: [CommonModule, LucideAngularModule, ButtonComponent, ToggleComponent],
  templateUrl: './layers.component.html',
  styleUrl: './layers.component.scss'
})
export class LayersComponent {
  readonly i18n = inject(I18nService);
  readonly state = inject(WildfireStateService);

  readonly layersIcon = Layers;
  readonly resetIcon = RotateCcw;
  readonly closeIcon = X;

  readonly sections = computed<LayerSection[]>(() => {
    const t = this.i18n.t();
    return [
      {
        id: 'fire',
        title: t.layersSectionFire,
        items: [
          {
            id: 'hotspots',
            label: t.layerHotspots,
            swatch: '#ea580c',
            checked: this.state.showHotspotsOnGlobe(),
            setChecked: (v) => this.state.showHotspotsOnGlobe.set(v)
          },
          {
            id: 'bbox',
            label: t.layerRegionBbox,
            swatch: '#d37400',
            checked: this.state.showRegionBbox(),
            setChecked: (v) => this.state.showRegionBbox.set(v)
          }
        ]
      },
      {
        id: 'base',
        title: t.layersSectionBase,
        items: [
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
            : [])
        ]
      }
    ];
  });
}
