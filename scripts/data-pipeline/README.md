# Data pipeline – dane bazowe dla AOI pożarów

`fetch_aoi_basemaps.py` czyta `aoi.csv` z katalogu głównego repo i dla każdego AOI (bbox wokół
dużego pożaru) pobiera dane do `data/raw/aoi/<aoi_id>/` (objęty regułą `data/raw/*` w `.gitignore`).

```bash
pip install -r requirements.txt
python scripts/data-pipeline/fetch_aoi_basemaps.py                      # wszystkie AOI, wszystko
python scripts/data-pipeline/fetch_aoi_basemaps.py --only larouco_2025 --what osm
python scripts/data-pipeline/fetch_aoi_basemaps.py --ortho-res 2.5 --topo-zoom 14
```

| Katalog | Źródło | Format | Licencja |
|---|---|---|---|
| `osm/*.geojson` | OpenStreetMap / Overpass API: roads, railways, waterways, water, landuse, natural, buildings, places, peaks, power, protected_areas, fire_infrastructure | GeoJSON, EPSG:4326 | ODbL |
| `ortho/pnoa.tif` | IGN PNOA, ortofoto Hiszpanii (domyślnie 5 m) | GeoTIFF, EPSG:3857 | CC BY 4.0 |
| `ortho/dgt2023.tif` | DGT OrtoSat 2023, ortofoto Portugalii | GeoTIFF, EPSG:3857 | CC BY 4.0 |
| `ortho/s2c_<rok>.tif` | EOX Sentinel-2 cloudless, kompozyt roczny: rok przed pożarem i rok pożaru (jeśli już wydany), 10 m | GeoTIFF, EPSG:3857 | CC BY-NC-SA 4.0 |
| `topo/opentopomap_z13.tif` | OpenTopoMap (poziomice, cieniowanie, nazwy) | GeoTIFF, EPSG:3857 | CC BY-SA 3.0 |
| `dem/*.tif` | Copernicus DEM GLO-30, całe kafle 1°×1° (bez przycinania) | COG, EPSG:4326 | Copernicus (atrybucja) |

Każde AOI ma też `aoi.geojson` (bbox + punkt zapłonu) i `manifest.json` (parametry, atrybucje, liczba obiektów).

Uwagi:
- Pliki, które już istnieją, są pomijane, więc po błędzie wystarczy uruchomić skrypt ponownie. `--force` pobiera wszystko od nowa.
- Publiczny Overpass bywa przeciążony (HTTP 502/429). Skrypt ponawia zapytania i przełącza się na serwery zapasowe.
- Ortofoto krajowe to zwykle ostatnia dostępna mozaika, która może pochodzić sprzed pożaru albo z okresu po nim. Do oceny stanu przed i po pożarze (dNBR) używaj scen Sentinel-2 L2A z okien `pre_fire_*` / `post_fire_*` w `aoi.csv`.
- Rozdzielczość: 5 m dla AOI ok. 40×50 km daje mozaikę ok. 9000×10000 px (~250 MB RAM). Przy `--ortho-res 1` potrzeba kilku GB RAM.
