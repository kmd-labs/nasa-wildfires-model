# Backend: pobieranie MODIS + VIIRS, harmonizacja, API dla aplikacji

Użytkownik wybiera w aplikacji BBOX i zakres dat. Backend pobiera hot spoty z NASA FIRMS dla tego obszaru,
trzyma je w cache na dysku, harmonizuje MODIS z VIIRS i zwraca kalendarz aktywności pożarowej oraz CSV.

```bash
pip install -r backend/requirements.txt

python -m backend seed                      # wczytuje data/raw/firms jako gotowy region Iberii, bez klucza i bez sieci
python -m backend serve --port 8000         # API pod http://127.0.0.1:8000, dokumentacja pod /docs
python -m backend fetch --bbox=-125,32,-114,42     # pobiera z FIRMS pełną historię nowego obszaru (wymaga FIRMS_MAP_KEY)
python -m backend calendar --bbox=-8.11,40.00,-7.62,40.43 --from 2025-08 --to 2025-08 --json out.json --csv out.csv
python -m backend burned-area --bbox=-8.7,39.6,-7.0,41.0 --product MCD64A1   # powierzchnia spalona + test szwu (wymaga EARTHDATA_TOKEN)
python -m pytest backend/tests -q
```

## API

| Wywołanie | Odpowiedź |
|---|---|
| `GET /api/calendar?bbox=W,S,E,N&from=YYYY-MM&to=YYYY-MM` | `200` kalendarz i podsumowanie wybranego okresu; `202` gdy obszar pobiera się pierwszy raz |
| `GET /api/hotspots.csv?bbox=W,S,E,N&from=YYYY-MM-DD&to=YYYY-MM-DD` | CSV wszystkich hot spotów z wyszukiwania; kolumna `used_in_calendar` mówi, które przeszły kontrolę jakości |
| `GET /api/burned-area?bbox=W,S,E,N&product=MCD64A1&from=YYYY-MM&to=YYYY-MM` | `200` miesięczna powierzchnia spalona (km²) z NASA LP DAAC i test szwu kalendarza; `202` przy pierwszym pobieraniu kafli |
| `GET /api/health` | stan, lista regionów w cache, czy jest klucz FIRMS i token Earthdata |

Odpowiedź `200` z `/api/calendar`:

- `series`: szeregi miesięczne od 2000-11: `rawModis`, `rawViirs`, `naiveSum`, `harmonized` z przedziałem 90 %
  (`harmonizedLo90`, `harmonizedHi90`), `anomalyZ`, `percentile`; oś czasu w `months`
- `calendar`: macierz rok × miesiąc wartości zharmonizowanych, gotowa pod mapę ciepła
- `climatology`, `yearly`: średnie miesięczne i sumy roczne
- `selection`: wybrany okres: liczba hot spotów, porównanie z tymi samymi miesiącami w innych latach
  (mediana, percentyl, miejsce, pięć najwyższych lat) oraz `cells`, czyli komórki H3 z wartościami pod mapę
- `validation`: test poza próbą dla tego obszaru (`null`, gdy obszar ma za mało danych)
- `metadata`: jednostka, `dataThrough`, `monthInProgress`, `refreshing`, kalibracja platform, atrybucja NASA FIRMS
- `seamTest`: test szwu względem powierzchni spalonej (`{MCD64A1: …, VNP64A1: …}`), tylko gdy kafle tego obszaru są już
  w cache; `null` w przeciwnym razie. Kalendarz nigdy nie czeka na pobieranie powierzchni spalonej

Po stronie aplikacji wystarczy odpytywać ten sam adres, dopóki przychodzi `202`:

```ts
async function loadCalendar(bbox: number[], from: string, to: string, onProgress: (p: { done: number; total: number }) => void) {
  const url = `${API_URL}/api/calendar?bbox=${bbox.join(',')}&from=${from}&to=${to}`;
  for (;;) {
    const response = await fetch(url);
    const body = await response.json();
    if (response.status === 200) return body;
    if (response.status !== 202) throw new Error(body.error);
    onProgress(body.progress);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
```

## Pobieranie i cache

Dane pochodzą z FIRMS Area API, tym samym wywołaniem co w `scripts/notebooks/01_extract_data.ipynb`.
Dla każdego sensora (MODIS, VIIRS S-NPP, NOAA-20, NOAA-21) cała historia jest pocięta na stałe kawałki po
`FIRMS_CHUNK_DAYS` dni. Kawałek pobrany w całości z danych naukowych (`*_SP`) jest ostateczny i nie pobiera się
ponownie. Kawałki z danych bieżących (`*_NRT`) odświeżają się po `FIRMS_REFRESH_HOURS`.

Region w cache to BBOX zaokrąglony na zewnątrz do 0,5°. Zapytanie mieszczące się w istniejącym regionie korzysta
z niego bez pobierania, więc jeden duży region obsługuje każdy BBOX w jego środku.

Pierwsze zapytanie o nowy obszar to pełna historia od 2000 r.: około 3 900 zapytań do FIRMS przy kawałkach
5-dniowych, około 1 950 przy 10-dniowych. To trwa minuty, dlatego API odpowiada `202` z postępem. Obszary na pokaz
warto pobrać wcześniej poleceniem `fetch`, a Iberię wczytać poleceniem `seed`.

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `FIRMS_MAP_KEY` | brak | klucz FIRMS; zostaje po stronie serwera. Bez klucza API działa tylko na danych z cache |
| `FIRMS_CACHE_DIR` | `data/cache/firms` | katalog cache |
| `FIRMS_CHUNK_DAYS` | `5` | długość kawałka; dokumentacja Area API podaje maksimum 10 |
| `FIRMS_WORKERS` | `4` | liczba równoległych zapytań |
| `FIRMS_REFRESH_HOURS` | `6` | po ilu godzinach odświeżać dane bieżące |
| `CORS_ORIGINS` | `http://localhost:4200` | adresy aplikacji, po przecinku |
| `EARTHDATA_TOKEN` | brak | token NASA Earthdata (Bearer) do pobierania MCD64A1 / VNP64A1 z LP DAAC |
| `BURNED_AREA_CACHE_DIR` | `data/cache/burned_area` | cache spalonych pikseli (tylko piksele spalone, plik HDF jest usuwany) |
| `BURNED_AREA_WORKERS` | `4` | liczba równoległych pobrań kafli |

### Powierzchnia spalona (świadek dla testu szwu)

`burned_area.py` szuka w NASA CMR kafli MCD64A1 v061 (MODIS, od 2000-11) albo VNP64A1 v002 (VIIRS S-NPP, od
2012-03) dla BBOX i miesięcy, pobiera każdy kafel 10° × 10° (HDF4, ok. 1,5 MB) raz, z nagłówkiem
`Authorization: Bearer $EARTHDATA_TOKEN`, i zapisuje tylko spalone piksele (wiersz, kolumna, dzień spalenia).
Każdy BBOX w obrębie pobranych kafli liczy się potem bez sieci: piksel 463 m (21,5 ha) wlicza się, gdy jego środek
leży w BBOX. Pełna historia jednego kafla to ok. 310 plików i kilka minut. Produkty publikowane są z opóźnieniem
około 2–3 miesięcy.

## Harmonizacja

Każdy satelita (Terra, Aqua, S-NPP, NOAA-20, NOAA-21) ma wyznaczoną efektywność detekcji względem MODIS
(Terra + Aqua) dla komórki H3 i miesiąca kalendarzowego, na miesiącach wspólnej pracy. Wartość zharmonizowana to
suma wszystkich detekcji podzielona przez sumę efektywności satelitów działających w danym miesiącu. Jednostką są
hot spoty w ekwiwalencie MODIS. Dojście lub wyłączenie satelity zmienia precyzję oszacowania, a nie jego poziom.

Dla małego albo spokojnego obszaru efektywności ściągane są do wartości typowych (`priorWeight` w odpowiedzi
pokazuje, w jakim stopniu). Rozdzielczość H3 dobiera się do wielkości BBOX: od 7 dla pojedynczego pożaru do 5 dla
całego półwyspu. Szczegóły są w docstringu `harmonization.py`.

## Wdrożenie

GitHub Pages serwuje tylko pliki statyczne, więc API musi działać osobno (kontener z `backend/Dockerfile` na
dowolnym hostingu), a aplikacja musi znać jego adres. Cache powinien leżeć na trwałym dysku.

## Ograniczenia

- Region z `seed` obejmuje tylko komórki, w których pliki krajowe Hiszpanii i Portugalii mają detekcje.
- Krótkie przerwy w pracy satelity wewnątrz miesiąca nie są modelowane.
- Przedział 90 % zakłada rozkład Poissona i znane efektywności, więc jest dolnym ograniczeniem niepewności.
- BBOX większy niż 400 stopni kwadratowych jest odrzucany.

## Harmonization version

`HARMONIZATION=v1|v2|v3` picks the module (default `v1`). v3 counts exactly like v2 and adds the small-fire layer, a weight per hot spot (`weight` column in the CSV), median stats and calibrated intervals; see [`docs/harmonization.md`](../docs/harmonization.md).

### Seam test

`harmonization3.seam_test()` checks whether a series steps, relative to burned area, when a satellite joins
(Aqua 2002-07, S-NPP 2012-01, NOAA-20 2018-04, NOAA-21 2023-03). Burned area is mapped from surface reflectance by
one sensor family, so it does not change when VIIRS joins the hot-spot record. The record is cut into 12-month
blocks starting at the seam month and fitted as
`log(hot spots) = a + beta * log(burned area) + sum_k gamma_k * after_k`, all seams at once. `beta` (about 0.5 on
Iberia) absorbs real changes in fire activity; `gamma` of a seam is the step it left, with `t = gamma / se`.
Verdicts: `noSeam`, `seamUp`, `seamDown`, `insufficient` (fewer than 2 blocks on a side or 5 degrees of freedom).
Results for Portugal are in [`docs/harmonization.md`](../docs/harmonization.md).
