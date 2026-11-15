# Global validation of the MODIS–VIIRS harmonization

Generated 2026-11-15 05:13. 22 regions, versions v4, v3. Data: NASA FIRMS yearly country files (MODIS 2000–2025, VIIRS S-NPP 2012–2025, NOAA-20 2018–2025), NOAA-21 from the Area API when available; witness: MCD64A1.

Errors are VIIRS-only predictions of raw MODIS (Terra + Aqua): **bias** is the total over the period, **error** the median absolute monthly error over months with ≥ 50 MODIS hot spots. k-fold: v3/v4 blocked by years; v1 even/odd years. Forward: fitted on years ≤ 2023, predicting 2024 and 2025.

## v4 in short

- Regions validated: 22 (0 with errors).
- k-fold, raw MODIS predicted from VIIRS through the drift law: median |bias| 2012–19 1.1%, 2020–22 3.9%, 2023+ 2.7%; median monthly error 2023+ 15.3%.
- |bias| 2023+ within 10%: 19 of 22 regions; within 20%: 22 of 22.
- Forward test (fit on years up to 2023): median |bias| 2024 11.0%, 2025 8.3%; 2025 within 15%: 17 of 22 regions.
- 90% interval coverage (k-fold, calibrated): median 0.9.
- 2012 jump of the harmonized series: median 1.0× (1 = no jump).
- Measured overpass shift in the last month: Terra median -1.36 h, Aqua +1.39 h (ranges -1.45 to -1.27 and +0.86 to +1.48).

## All versions (median across regions)

| Version | k-fold \|bias\| 2012–19 | 2020–22 | 2023+ | k-fold error 2012–19 | 2023+ | forward \|bias\| 2024 | 2025 | forward error | 90% coverage | 2012 jump (harmonized) |
|---|---|---|---|---|---|---|---|---|---|---|
| v4 | 1.1% | 3.9% | 2.7% | 11.2% | 15.3% | 11.0% | 8.3% | 14.1% | 0.9 | 1.0× |
| v3 | 2.8% | 2.6% | 4.0% | 10.6% | 14.3% | 12.2% | 11.5% | 13.6% | 0.9 | 1.0× |

For comparison, the 2012 jump of the naive sum (MODIS + VIIRS) has a median of 4.64× and of MODIS alone 1.00×.

## v4 against v3 (regions where v4 is closer to raw MODIS)

- k-fold |bias| 2023+: v4 better in 13 of 22 regions (median 4.0% → 2.7%)
- k-fold error 2023+: v4 better in 7 of 22 regions (median 14.3% → 15.3%)
- forward |bias| 2024: v4 better in 12 of 22 regions (median 12.2% → 11.0%)
- forward |bias| 2025: v4 better in 13 of 22 regions (median 11.5% → 8.3%)
- k-fold |bias| 2012–19: v4 better in 19 of 22 regions (median 2.8% → 1.1%)
- k-fold error 2012–19: v4 better in 14 of 22 regions (median 10.6% → 11.2%)

## By biome (median, v3 → v4)

| Biome | Regions | k-fold \|bias\| 2023+ | forward \|bias\| 2025 | k-fold error 2023+ |
|---|---|---|---|---|
| boreal | 2 | 6.5 → 2.6 | 13.0 → 2.3 | 15.9 → 15.8 |
| cropland | 1 | 1.4 → 1.9 | 33.4 → 11.1 | 27.6 → 23.2 |
| grassland | 1 | 11.3 → 5.6 | 3.1 → 0.3 | 16.3 → 18.0 |
| mediterranean | 4 | 15.0 → 11.2 | 21.0 → 18.0 | 19.2 → 25.4 |
| peat | 1 | 12.4 → 10.4 | 15.1 → 16.6 | 18.3 → 16.4 |
| savanna | 7 | 2.4 → 1.8 | 6.1 → 6.1 | 12.5 → 10.7 |
| temperate | 2 | 4.0 → 2.7 | 11.9 → 9.6 | 14.3 → 11.8 |
| tropical_forest | 4 | 3.9 → 2.4 | 11.8 → 7.8 | 11.3 → 15.9 |

## Regions

| Region | Biome | Version | k-fold bias 2012–19 | 2023+ | error 2023+ | forward 2024 | 2025 | 2012 jump |
|---|---|---|---|---|---|---|---|---|
| argentina_chaco | savanna | v4 | -0.23 | -1.67 | 9.9 | -12.4 | -10.4 | 0.664 |
| argentina_chaco | savanna | v3 | -1.97 | -2.35 | 12.5 | -13.7 | -12.2 | 0.649 |
| australia_se | temperate | v4 | 2.53 | -2.11 | 14.2 | -6.5 | -8.6 | 1.333 |
| australia_se | temperate | v3 | -12.95 | -5.46 | 14.5 | -3.5 | -5.3 | 1.313 |
| australia_top_end | savanna | v4 | -0.65 | 1.7 | 7.1 | 3.8 | 6.1 | 1.137 |
| australia_top_end | savanna | v3 | -2.5 | -2.68 | 13.3 | 1.7 | 10.8 | 1.12 |
| bolivia_chiquitania | tropical_forest | v4 | 5.56 | 2.17 | 18.5 | 16.3 | 8.1 | 0.415 |
| bolivia_chiquitania | tropical_forest | v3 | -0.68 | 10.74 | 16.9 | 29.0 | 17.7 | 0.405 |
| brazil_cerrado | savanna | v4 | -1.02 | -1.17 | 14.1 | -7.5 | 5.1 | 0.938 |
| brazil_cerrado | savanna | v3 | -2.6 | -3.46 | 13.7 | -3.4 | 7.8 | 0.929 |
| brazil_rondonia | tropical_forest | v4 | -2.37 | -2.59 | 20.7 | -2.4 | 7.4 | 0.987 |
| brazil_rondonia | tropical_forest | v3 | -3.6 | -1.58 | 10.4 | -0.6 | 9.7 | 0.979 |
| california | mediterranean | v4 | -2.67 | -3.54 | 19.3 | -18.3 | 43.7 | 2.089 |
| california | mediterranean | v3 | -4.77 | -14.83 | 16.4 | -28.8 | 23.4 | 2.05 |
| canada_alberta | boreal | v4 | 3.88 | 2.41 | 18.2 | -18.5 | 0.1 | 3.277 |
| canada_alberta | boreal | v3 | -5.22 | -4.35 | 17.2 | -14.8 | 1.9 | 3.247 |
| ghana_north | savanna | v4 | 0.48 | 2.75 | 12.0 | -9.4 | -1.7 | 0.872 |
| ghana_north | savanna | v3 | -1.05 | -2.32 | 11.4 | -10.8 | 5.4 | 0.86 |
| greece | mediterranean | v4 | -5.57 | -16.06 | 22.8 | -18.6 | -14.0 | 0.95 |
| greece | mediterranean | v3 | -7.27 | -10.54 | 21.8 | -19.9 | -12.7 | 0.929 |
| india_punjab | cropland | v4 | 0.42 | -1.94 | 23.2 | -18.1 | -11.1 | 1.02 |
| india_punjab | cropland | v3 | -1.13 | 1.4 | 27.6 | -28.9 | -33.4 | 1.009 |
| indonesia_kalimantan | peat | v4 | -1.79 | -10.44 | 16.4 | -8.3 | 16.6 | 1.898 |
| indonesia_kalimantan | peat | v3 | -4.17 | -12.44 | 18.3 | -8.1 | 15.1 | 1.861 |
| kazakhstan_steppe | grassland | v4 | 0.18 | 5.56 | 18.0 | 0.7 | -0.3 | 0.558 |
| kazakhstan_steppe | grassland | v3 | -3.04 | 11.3 | 16.3 | -4.5 | 3.1 | 0.546 |
| mexico_yucatan | tropical_forest | v4 | 0.46 | 1.23 | 10.8 | -11.6 | -2.1 | 0.921 |
| mexico_yucatan | tropical_forest | v3 | -3.31 | -3.97 | 5.9 | -12.8 | 1.1 | 0.897 |
| mozambique | savanna | v4 | 0.5 | 1.78 | 16.9 | -16.5 | -21.5 | 1.072 |
| mozambique | savanna | v3 | -1.86 | -3.95 | 13.5 | -12.7 | -6.1 | 1.055 |
| portugal_centro | mediterranean | v4 | 1.54 | -6.44 | 28.0 | 41.5 | -11.6 | 0.727 |
| portugal_centro | mediterranean | v3 | 0.37 | 15.21 | 16.7 | 54.5 | 23.3 | 0.721 |
| russia_transbaikal | boreal | v4 | 1.86 | 2.7 | 13.5 | 11.3 | 4.6 | 1.865 |
| russia_transbaikal | boreal | v3 | -0.49 | 8.68 | 14.7 | 19.9 | 24.1 | 1.855 |
| south_sudan | savanna | v4 | 0.17 | 4.18 | 10.7 | -8.8 | -2.4 | 1.052 |
| south_sudan | savanna | v3 | -1.74 | -2.28 | 10.2 | -8.5 | 6.0 | 1.043 |
| thailand_north | tropical_forest | v4 | -0.56 | -6.9 | 13.4 | -1.9 | -18.9 | 1.081 |
| thailand_north | tropical_forest | v3 | -3.77 | -3.9 | 12.2 | 3.0 | -13.8 | 1.051 |
| turkey_sw | mediterranean | v4 | -9.0 | -18.29 | 29.0 | -21.8 | -22.0 | 0.819 |
| turkey_sw | mediterranean | v3 | -9.79 | -15.3 | 26.1 | -14.3 | -18.6 | 0.808 |
| us_southeast | temperate | v4 | -1.08 | 3.22 | 9.3 | 10.7 | 10.7 | 0.872 |
| us_southeast | temperate | v3 | -3.1 | -2.52 | 14.1 | 7.9 | 18.5 | 0.868 |
| zambia | savanna | v4 | -1.05 | 6.04 | 9.7 | -8.3 | 7.7 | 1.056 |
| zambia | savanna | v3 | -1.37 | -2.03 | 7.9 | -11.8 | 1.7 | 1.049 |

## MODIS orbit drift measured by v4

| Region | Terra shift (h) | Aqua shift (h) | measured here | Terra day | Terra night | Aqua day | Aqua night |
|---|---|---|---|---|---|---|---|
| argentina_chaco | -1.33 | 1.4 | True/True | 0.855 | 1.499 | 1.365 | 0.744 |
| australia_se | -1.36 | 1.39 | False/False | 0.638 | 1.379 | 1.007 | 0.767 |
| australia_top_end | -1.34 | 1.41 | True/True | 0.521 | 1.155 | 0.977 | 0.793 |
| bolivia_chiquitania | -1.41 | 1.37 | True/True | 0.747 | 0.99 | 1.154 | 0.738 |
| brazil_cerrado | -1.27 | 1.35 | True/True | 0.827 | 1.636 | 1.012 | 0.989 |
| brazil_rondonia | -1.36 | 1.39 | False/False | 0.77 | 1.318 | 0.979 | 0.964 |
| california | -1.37 | 1.31 | True/True | 1.106 | 1.646 | 0.896 | 0.931 |
| canada_alberta | -1.36 | 0.86 | False/True | 0.607 | 1.125 | 1.236 | 1.033 |
| ghana_north | -1.45 | 1.4 | True/True | 0.558 | 1.499 | 0.956 | 0.583 |
| greece | -1.36 | 1.39 | False/False | 0.829 | 1.761 | 1.403 | 1.288 |
| india_punjab | -1.36 | 1.48 | False/True | 0.532 | 1.587 | 2.344 | 1.065 |
| indonesia_kalimantan | -1.36 | 1.39 | False/False | 0.66 | 1.327 | 1.232 | 0.948 |
| kazakhstan_steppe | -1.36 | 1.39 | False/False | 1.135 | 0.769 | 0.99 | 0.663 |
| mexico_yucatan | -1.34 | 1.46 | True/True | 0.527 | 1.996 | 1.11 | 0.665 |
| mozambique | -1.36 | 1.46 | False/True | 0.254 | 1.59 | 1.126 | 0.281 |
| portugal_centro | -1.36 | 1.39 | False/False | 0.907 | 1.057 | 0.648 | 0.742 |
| russia_transbaikal | -1.36 | 1.39 | False/False | 0.571 | 1.527 | 0.958 | 1.443 |
| south_sudan | -1.34 | 1.41 | True/True | 0.37 | 1.488 | 0.98 | 0.71 |
| thailand_north | -1.33 | 1.43 | True/True | 1.141 | 1.208 | 1.122 | 0.666 |
| turkey_sw | -1.36 | 1.39 | False/False | 1.082 | 1.453 | 1.364 | 1.031 |
| us_southeast | -1.34 | 1.3 | True/True | 0.683 | 1.552 | 0.729 | 0.707 |
| zambia | -1.36 | 1.39 | False/False | 0.47 | 1.341 | 1.166 | 0.692 |

Factors are the drift law's multiplier of the nominal efficiency in the last month (1 = no change).

## Seam test against MCD64A1 burned area

Step of each series relative to burned area at the satellite seam (t in brackets; |t| ≥ 2 is a seam).

| Region | Seam | naive sum | raw MODIS | harmonized v4 | harmonized v3 |
|---|---|---|---|---|---|
| argentina_chaco | SNPP | +164% (6.13) | -33% (-2.62) | -34% (-2.56) | -35% (-2.74) |
| argentina_chaco | NOAA20 | +131% (5.63) | +31% (1.93) | +36% (2.11) | +30% (1.87) |
| argentina_chaco | NOAA21 | +36% (1.45) | +5% (0.23) | -5% (-0.24) | +5% (0.24) |
| australia_se | SNPP | +291% (4.69) | -26% (-1.31) | -27% (-1.46) | -30% (-1.6) |
| australia_se | NOAA20 | +86% (2.3) | -6% (-0.26) | +0% (0.02) | -2% (-0.07) |
| australia_se | NOAA21 | -2% (-0.05) | -18% (-0.73) | -24% (-1.02) | -24% (-1.01) |
| australia_top_end | SNPP | +494% (39.85) | +8% (1.71) | +8% (1.97) | +6% (1.71) |
| australia_top_end | NOAA20 | +98% (10.69) | +6% (1.73) | +6% (1.74) | +4% (1.28) |
| australia_top_end | NOAA21 | +47% (6.42) | +4% (0.82) | +7% (1.37) | -0% (-0.03) |
| bolivia_chiquitania | SNPP | +392% (7.19) | +1% (0.02) | +1% (0.03) | -3% (-0.14) |
| bolivia_chiquitania | NOAA20 | +140% (3.58) | +40% (1.22) | +38% (1.24) | +38% (1.24) |
| bolivia_chiquitania | NOAA21 | +50% (1.48) | +64% (1.55) | +55% (1.49) | +60% (1.59) |
| brazil_cerrado | SNPP | +373% (25.94) | +3% (0.53) | +2% (0.33) | +1% (0.18) |
| brazil_cerrado | NOAA20 | +97% (7.68) | +6% (1.09) | +9% (1.79) | +6% (1.16) |
| brazil_cerrado | NOAA21 | +2% (0.26) | +16% (2.05) | +3% (0.39) | +12% (1.57) |
| brazil_rondonia | SNPP | +501% (13.25) | +24% (1.54) | +22% (1.56) | +21% (1.47) |
| brazil_rondonia | NOAA20 | +87% (3.43) | +3% (0.23) | +4% (0.31) | +4% (0.29) |
| brazil_rondonia | NOAA21 | +17% (0.82) | -15% (-1.06) | -18% (-1.37) | -14% (-1.08) |
| california | SNPP | +320% (5.58) | -11% (-0.49) | -10% (-0.41) | -12% (-0.53) |
| california | NOAA20 | +189% (4.33) | +61% (2.21) | +66% (2.07) | +61% (2.11) |
| california | NOAA21 | -15% (-0.43) | +2% (0.05) | -16% (-0.45) | -9% (-0.26) |
| canada_alberta | SNPP | +702% (6.26) | +57% (1.58) | +44% (1.17) | +43% (1.26) |
| canada_alberta | NOAA20 | +24% (0.74) | -21% (-0.94) | -26% (-1.05) | -21% (-0.91) |
| canada_alberta | NOAA21 | +345% (3.16) | +166% (2.42) | +150% (2.06) | +157% (2.32) |
| ghana_north | SNPP | +268% (25.02) | -15% (-3.02) | -15% (-4.3) | -16% (-4.52) |
| ghana_north | NOAA20 | +73% (10.7) | +1% (0.11) | -2% (-0.39) | -3% (-0.55) |
| ghana_north | NOAA21 | +33% (4.26) | -7% (-0.98) | -9% (-1.41) | -13% (-1.91) |
| greece | SNPP | +305% (10.09) | -6% (-0.43) | -8% (-0.58) | -11% (-0.73) |
| greece | NOAA20 | +86% (5.09) | -7% (-0.58) | -5% (-0.38) | -5% (-0.4) |
| greece | NOAA21 | +10% (0.55) | -3% (-0.19) | -26% (-1.62) | -7% (-0.39) |
| india_punjab | SNPP | +449% (14.62) | -2% (-0.18) | -2% (-0.17) | -4% (-0.37) |
| india_punjab | NOAA20 | +65% (5.18) | -7% (-0.92) | -12% (-1.92) | -9% (-1.34) |
| india_punjab | NOAA21 | -7% (-0.42) | -32% (-2.52) | -35% (-3.24) | -22% (-1.66) |
| indonesia_kalimantan | SNPP | +241% (3.46) | -42% (-1.57) | -40% (-1.49) | -41% (-1.57) |
| indonesia_kalimantan | NOAA20 | +63% (1.24) | -13% (-0.38) | -8% (-0.25) | -13% (-0.39) |
| indonesia_kalimantan | NOAA21 | +18% (0.34) | +0% (0.01) | -18% (-0.44) | -7% (-0.17) |
| kazakhstan_steppe | SNPP | +318% (7.29) | -9% (-0.42) | -12% (-0.61) | -14% (-0.71) |
| kazakhstan_steppe | NOAA20 | +78% (3.32) | -0% (-0.02) | +2% (0.11) | +2% (0.11) |
| kazakhstan_steppe | NOAA21 | +6% (0.23) | -10% (-0.32) | +1% (0.04) | -2% (-0.06) |
| mexico_yucatan | SNPP | +320% (13.06) | +4% (0.28) | +3% (0.27) | +1% (0.07) |
| mexico_yucatan | NOAA20 | +73% (9.19) | -7% (-0.89) | -5% (-0.83) | -7% (-1.03) |
| mexico_yucatan | NOAA21 | +77% (5.54) | +14% (0.94) | +11% (0.86) | +13% (0.99) |
| mozambique | SNPP | +533% (31.07) | +4% (0.59) | +3% (0.49) | +2% (0.3) |
| mozambique | NOAA20 | +79% (5.45) | -12% (-1.78) | -5% (-0.77) | -12% (-1.75) |
| mozambique | NOAA21 | +57% (3.64) | +15% (1.34) | +7% (0.68) | +13% (1.15) |
| portugal_centro | SNPP | +240% (9.09) | -8% (-0.64) | -6% (-0.41) | -7% (-0.51) |
| portugal_centro | NOAA20 | +22% (0.88) | -25% (-1.53) | -29% (-1.6) | -25% (-1.38) |
| portugal_centro | NOAA21 | +76% (2.22) | +7% (0.29) | +28% (0.99) | -0% (-0.0) |
| russia_transbaikal | SNPP | +294% (3.43) | -17% (-0.5) | -18% (-0.51) | -18% (-0.53) |
| russia_transbaikal | NOAA20 | -6% (-0.11) | -43% (-1.21) | -40% (-1.14) | -42% (-1.2) |
| russia_transbaikal | NOAA21 | +33% (0.53) | +3% (0.07) | -6% (-0.13) | -7% (-0.15) |
| south_sudan | SNPP | +374% (29.9) | +8% (1.75) | +8% (1.66) | +7% (1.49) |
| south_sudan | NOAA20 | +63% (8.13) | -8% (-1.89) | -6% (-1.78) | -9% (-2.42) |
| south_sudan | NOAA21 | +9% (1.09) | +1% (0.14) | +7% (1.4) | -2% (-0.46) |
| thailand_north | SNPP | +575% (12.49) | -9% (-0.53) | -6% (-0.34) | -8% (-0.5) |
| thailand_north | NOAA20 | +67% (1.8) | -22% (-1.39) | -27% (-1.92) | -27% (-1.88) |
| thailand_north | NOAA21 | +112% (2.22) | +46% (1.56) | +46% (1.75) | +52% (1.99) |
| turkey_sw | SNPP | +370% (6.88) | +14% (0.58) | +6% (0.27) | +6% (0.26) |
| turkey_sw | NOAA20 | +104% (3.92) | +4% (0.24) | +5% (0.27) | +12% (0.59) |
| turkey_sw | NOAA21 | -28% (-1.33) | -17% (-0.7) | -28% (-1.38) | -26% (-1.18) |
| us_southeast | SNPP | +243% (13.84) | +3% (0.4) | +0% (0.05) | -0% (-0.01) |
| us_southeast | NOAA20 | +62% (3.97) | -13% (-1.19) | -7% (-0.66) | -13% (-1.25) |
| us_southeast | NOAA21 | +72% (3.91) | +8% (0.54) | +19% (1.28) | +5% (0.35) |
| zambia | SNPP | +340% (35.95) | -0% (-0.09) | +0% (0.12) | -0% (-0.08) |
| zambia | NOAA20 | +66% (7.16) | -12% (-3.85) | -10% (-3.16) | -10% (-2.97) |
| zambia | NOAA21 | +4% (0.59) | +7% (1.67) | +2% (0.44) | +6% (1.38) |

Seams flagged (|t| ≥ 2): v4 7 of 66, v3 6 of 66.
