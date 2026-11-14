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
          },
          {
            id: 'wind',
            label: t.layerWindStreamlines,
            swatch: '#0ea5e9',
            checked: this.state.showWindStreamlines(),
            setChecked: (v) => this.state.showWindStreamlines.set(v)
          },
          {
            id: 'evac-routes',
            label: t.layerEscapeRoutes,
            swatch: '#10b981',
            checked: this.state.showEscapeRoads(),
            setChecked: (v) => this.state.showEscapeRoads.set(v)
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
            swatch: '#64748b',
            checked: this.state.showLandOrtho(),
            setChecked: (v) => this.state.showLandOrtho.set(v)
          },
          {
            id: 'osm',
            label: t.layerOsmTiles,
            swatch: '#0284c7',
            checked: this.state.showOsmTiles(),
            setChecked: (v) => this.state.showOsmTiles.set(v)
          },
          {
            id: 'forests',
            label: t.layerForests,
            swatch: '#168a42',
            checked: this.state.showForests(),
            setChecked: (v) => this.state.showForests.set(v)
          },
          {
            id: 'urban',
            label: t.layerUrbanAreas,
            swatch: '#475569',
            checked: this.state.showUrbanAreas(),
            setChecked: (v) => this.state.showUrbanAreas.set(v)
          },
          {
            id: 'borders',
            label: t.layerBorders,
            swatch: '#1e293b',
            checked: this.state.showBorders(),
            setChecked: (v) => this.state.showBorders.set(v)
          },
          {
            id: 'roads',
            label: t.layerRoads,
            swatch: '#94a3b8',
            checked: this.state.showRoads(),
            setChecked: (v) => this.state.showRoads.set(v)
          },
          {
            id: 'graticule',
            label: t.layerGraticule,
            swatch: '#cbd5e1',
            checked: this.state.showGraticule(),
            setChecked: (v) => this.state.showGraticule.set(v)
          }
        ]
      }
    ];
  });
}
