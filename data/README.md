# Data

Data for the Iberian wildfire model. The six areas of interest (AOIs) are defined in [`aoi.csv`](../aoi.csv) (#22).

| Folder | What it holds |
|---|---|
| [`raw/`](raw/) | Unmodified downloads from NASA FIRMS and Google Earth Engine (SRTM, MODIS, Sentinel-2, ERA5). See [`raw/README.md`](raw/README.md). |
| `../src/assets/data/` | Processed, H3-aggregated JSON served by the web app (planned, #25) |

## Re-creating or extending the raw data

Everything in `raw/` comes from [`scripts/notebooks/01_extract_data.ipynb`](../scripts/notebooks/01_extract_data.ipynb):

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt     # Linux/macOS: .venv/bin/pip
.venv\Scripts\earthengine authenticate            # once, opens the browser
# .env needs FIRMS_MAP_KEY and GEE_PROJECT (see .env.example)
```

Then run the notebook. Files that already exist are skipped, so a run only adds what's missing. `raw/manifest.json` records the source, time window and attribution of every file.

## Licences

All sources allow caching and redistribution with attribution. The text for each file is in `raw/manifest.json`.

| Source | Licence |
|---|---|
| NASA FIRMS, MODIS (MOD13Q1, MCD64A1), SRTM | US Government public domain, attribution requested |
| Copernicus Sentinel-2, ERA5 / ERA5-Land (Copernicus Climate Change Service) | Copernicus licence, free use with attribution |
