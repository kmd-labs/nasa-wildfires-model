# Raw data

Unmodified downloads produced by [`scripts/notebooks/01_extract_data.ipynb`](../../scripts/notebooks/01_extract_data.ipynb). The step letter matches the notebook section.

| Folder | Step | Dataset | Resolution | Format | Status (2026-11-14) |
|---|---|---|---|---|---|
| [`firms/aoi/`](firms/aoi/) | A | NASA FIRMS active fires, MODIS C6.1 and VIIRS 375 m, per AOI | 1 km / 375 m, each overpass | CSV | all 6 AOIs |
| [`firms/country/`](firms/country/) | B | FIRMS yearly country files, Spain and Portugal | 1 km / 375 m | CSV | MODIS 2000–2025, S-NPP 2012–2025, NOAA-20 2018–2025 |
| [`firms/api_iberia/`](firms/api_iberia/) | B | FIRMS Area API over the Iberia bbox, filling what the country files lack | 375 m / 1 km | CSV | NOAA-21 2023–2026, all sensors 2026 |
| [`terrain/`](terrain/) | C | SRTM `USGS/SRTMGL1_003`: elevation, slope, aspect | 30 m | GeoTIFF, AOI UTM zone | `losacio_2022_lipiec` only |
| [`ndvi/`](ndvi/) | D | MODIS `MOD13Q1`: pre-fire NDVI, climatology, anomaly, post-fire NDVI, AOI time series | 250 m, 16-day | GeoTIFF + CSV | `losacio_2022_lipiec` only |
| [`burned_area/`](burned_area/) | E | MODIS `MCD64A1` burn day of year | 500 m, monthly | GeoTIFF | `losacio_2022_lipiec` only |
| [`sentinel2/`](sentinel2/) | F | Sentinel-2 L2A NBR before and after the fire, dNBR (×1000) | 20 m | GeoTIFF | `losacio_2022_lipiec` only |
| [`weather/`](weather/) | G | ERA5-Land and ERA5 hourly: wind (10 m, 100 m, 850 hPa), gusts, temperature, humidity, precipitation, soil moisture | ~9 km / ~28 km, hourly | CSV | `losacio_2022_lipiec` only |

File names start with the `aoi_id` from [`aoi.csv`](../../aoi.csv), for example `piodao_2025_firms.csv`.
Column definitions for the FIRMS files are in [`firms/README.md`](firms/README.md).

The FIRMS country files cover Spain and Portugal including islands, while `api_iberia/` covers the bbox `[-9.6, 36.0, 3.4, 43.8]`, which includes a strip of southern France and Andorra. Clip both to the same mainland polygon before combining them.
