# NASA FIRMS active-fire detections

One row is **one pixel flagged as burning in one satellite overpass**. It is not one fire: a large fire produces hundreds of rows per overpass, and clouds or smoke can hide a burning area entirely.

- `aoi/<aoi_id>_firms.csv`: every sensor over the AOI's full window (`pre_fire_od` to `post_fire_do` in `aoi.csv`), from step A of the notebook.
- `country/`, `api_iberia/`: the whole peninsula for the harmonized calendar, from step B. These are local only.

## Sources

| `sensor` | Satellites (`satellite`) | Pixel at nadir | Science archive (SP) from | `source` values |
|---|---|---|---|---|
| `MODIS` | Terra, Aqua | 1 km | 2000-11-01 | `MODIS_SP`, `MODIS_NRT` |
| `VIIRS_SNPP` | `N` (Suomi NPP) | 375 m | 2012-01-20 | `VIIRS_SNPP_SP`, `VIIRS_SNPP_NRT` |
| `VIIRS_NOAA20` | `N20` | 375 m | 2018-04-01 | `VIIRS_NOAA20_SP`, `VIIRS_NOAA20_NRT` |
| `VIIRS_NOAA21` | `N21` | 375 m | 2023-03-01 | `VIIRS_NOAA21_SP`, `VIIRS_NOAA21_NRT` |

The notebook uses the science-quality archive (`*_SP`) wherever it covers the day. Near-real-time (`*_NRT`) fills only the period the archive hasn't reached yet: after 2026-07-31 for VIIRS and after 2026-08-31 for MODIS, as of 2026-11-14.

## Columns

| Column | Sensor | Meaning |
|---|---|---|
| `latitude`, `longitude` | all | Centre of the fire pixel (WGS84). The fire is somewhere inside the pixel. |
| `scan`, `track` | all | Actual pixel size in km across and along the satellite track. It grows towards the swath edge, up to about 2 × 4.8 km for MODIS and 0.8 × 0.8 km for VIIRS. |
| `acq_date`, `acq_time` | all | Overpass date and time, UTC (`acq_time` as `HHMM`). |
| `acq_datetime_utc` | all | The two above combined (added by the notebook). |
| `satellite`, `instrument` | all | See the table above. |
| `confidence` | MODIS | Detection confidence, 0–100 %. |
| `confidence` | VIIRS | `l` low, `n` nominal, `h` high. |
| `frp` | all | Fire radiative power of the pixel in MW: how intensely it burned at that moment. |
| `brightness`, `bright_t31` | MODIS | Brightness temperature (K) of channel 21/22 (~4 µm) and channel 31 (~11 µm). |
| `bright_ti4`, `bright_ti5` | VIIRS | Brightness temperature (K) of channel I-4 (~3.7 µm) and I-5 (~11 µm). |
| `daynight` | all | `D` day, `N` night overpass. |
| `type` | SP only | `0` presumed vegetation fire, `1` active volcano, `2` other static land source, `3` offshore. Empty for NRT rows. |
| `version` | all | Product collection, e.g. `61.03` (MODIS C6.1), `2` (VIIRS), `2.0NRT`. |
| `source`, `sensor` | all | FIRMS source id and sensor family (added by the notebook). |

## Attribution

> We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://www.earthdata.nasa.gov/firms), part of NASA's Earth Science Data and Information System (ESDIS).

FIRMS data are US Government public domain.
