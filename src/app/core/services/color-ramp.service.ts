import { Injectable } from '@angular/core';
import { ColorRampId } from '../models/wildfire.model';

export interface ColorRampStop {
  t: number;
  rgb: [number, number, number];
}

export interface ColorRampDefinition {
  id: ColorRampId;
  stops: ColorRampStop[];
  cssGradient: string;
}

/**
 * Accessible, perceptually uniform and colorblind-safe (CVD-safe) color ramps
 * for fire intensity, burning calendar heatmaps, and 3D globe hotspot markers.
 */
@Injectable({
  providedIn: 'root'
})
export class ColorRampService {
  private readonly ramps: Record<ColorRampId, ColorRampDefinition> = {
    okabeIto: {
      id: 'okabeIto',
      stops: [
        { t: 0.0, rgb: [86, 180, 233] },  // #56b4e9 sky blue
        { t: 0.35, rgb: [240, 228, 66] }, // #f0e442 yellow
        { t: 0.7, rgb: [230, 159, 0] },   // #e69f00 amber-orange
        { t: 1.0, rgb: [213, 94, 0] }     // #d55e00 vermilion
      ],
      cssGradient: 'linear-gradient(90deg, #56b4e9 0%, #f0e442 35%, #e69f00 70%, #d55e00 100%)'
    },
    cividis: {
      id: 'cividis',
      stops: [
        { t: 0.0, rgb: [0, 32, 77] },     // #00204d
        { t: 0.33, rgb: [65, 77, 107] },  // #414d6b
        { t: 0.67, rgb: [166, 157, 117] },// #a69d75
        { t: 1.0, rgb: [255, 234, 70] }   // #ffea46
      ],
      cssGradient: 'linear-gradient(90deg, #00204d 0%, #414d6b 33%, #a69d75 67%, #ffea46 100%)'
    },
    viridis: {
      id: 'viridis',
      stops: [
        { t: 0.0, rgb: [68, 1, 84] },     // #440154
        { t: 0.33, rgb: [49, 104, 142] }, // #31688e
        { t: 0.67, rgb: [53, 183, 121] }, // #35b779
        { t: 1.0, rgb: [253, 231, 37] }   // #fde725
      ],
      cssGradient: 'linear-gradient(90deg, #440154 0%, #31688e 33%, #35b779 67%, #fde725 100%)'
    },
    ylOrRd: {
      id: 'ylOrRd',
      stops: [
        { t: 0.0, rgb: [254, 217, 118] }, // #fed976
        { t: 0.35, rgb: [253, 141, 60] }, // #fd8d3c
        { t: 0.7, rgb: [227, 26, 28] },   // #e31a1c
        { t: 1.0, rgb: [128, 0, 38] }     // #800026
      ],
      cssGradient: 'linear-gradient(90deg, #fed976 0%, #fd8d3c 35%, #e31a1c 70%, #800026 100%)'
    }
  };

  /** Colorblind-safe diverging colors for anomaly charts (Okabe-Ito blue vs vermilion) */
  readonly anomalyNegativeHex = '#0072b2';
  readonly anomalyPositiveHex = '#d55e00';
  readonly anomalyNeutralHex = '#64748b';

  getRamp(id: ColorRampId): ColorRampDefinition {
    return this.ramps[id] ?? this.ramps.ylOrRd;
  }

  sampleRgb(id: ColorRampId, value01: number): [number, number, number] {
    const t = Math.max(0, Math.min(1, value01));
    const stops = this.getRamp(id).stops;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (t >= a.t && t <= b.t) {
        const localT = (t - a.t) / (b.t - a.t || 1);
        return [
          Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * localT),
          Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * localT),
          Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * localT)
        ];
      }
    }
    return stops[stops.length - 1].rgb;
  }

  sampleHex(id: ColorRampId, value01: number): string {
    const [r, g, b] = this.sampleRgb(id, value01);
    return `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
  }

  sampleInt(id: ColorRampId, value01: number): number {
    const [r, g, b] = this.sampleRgb(id, value01);
    return (r << 16) | (g << 8) | b;
  }
}
