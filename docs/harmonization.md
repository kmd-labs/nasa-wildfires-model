# Harmonizacja MODIS i VIIRS (v3)

Jak zamieniamy hotspoty z dwóch rodzin kamer satelitarnych na jedną, porównywalną serię 2000–2026 dla kalendarza aktywności pożarowej. Kod: [`backend/harmonization3.py`](../backend/harmonization3.py), testy: [`backend/tests/test_harmonization3.py`](../backend/tests/test_harmonization3.py). Grafika: [`harmonization-v3.jpg`](harmonization-v3.jpg).

## Problem

| | MODIS (Terra, Aqua) | VIIRS (Suomi NPP, NOAA-20, NOAA-21) |
|---|---|---|
| Lata | 2000–2027 (koniec misji) | od 2012 |
| Piksel | 1 km | 375 m |
| Przeloty nad Iberią | 10:30 / 22:30, 13:30 / 01:30 | 13:30 / 01:30 |

VIIRS widzi też małe, słabe ogniska, których MODIS nie wykrywa. Po dołożeniu VIIRS w 2012 naiwna suma detekcji nad Iberią skacze 4,1 raza (8 305 → 33 905), choć pożarów nie przybyło. 65% kropek S-NPP ma moc poniżej 9 MW, a w MODIS tylko 20%.

## Rozwiązanie: dwie warstwy

Na wykresie i w kalendarzu każdy słupek ma dwie warstwy, z różnymi zadaniami:

1. **Warstwa porównywalna (oficjalna liczba).** Hotspoty w jednostkach MODIS (Terra + Aqua). Z niej powstaje kalendarz, mediana, anomalie i suma w eksporcie CSV.
2. **Warstwa małych ognisk (wyjaśnienie).** Detekcje VIIRS słabsze niż 8,8 MW w dzień i 7,5 MW w nocy, liczone na jednego satelitę VIIRS. Pokazuje, skąd wziął się skok w 2012. **Nie wchodzi do oficjalnej liczby.**

### Dlaczego oficjalna liczba nie pochodzi z progu mocy

Sprawdziliśmy prostszą metodę „liczymy tylko ogień ≥ próg, który widzi każda kamera” (Iberia, dopasowanie 2012–2018, sprawdzenie 2019–2025 względem MODIS):

| Metoda | Suma ÷ MODIS | Zakres w latach | Mediana błędu miesięcznego |
|---|---|---|---|
| Waga na każdą kropkę | 1,06 | 0,97–1,24 | **15%** |
| Jeden próg mocy | 1,20 | 0,81–1,57 | **43%** |

Próg myli się około 3 razy bardziej i wyolbrzymia skrajności, bo duży pożar rozbija się w VIIRS na wiele pikseli powyżej progu. Dlatego próg służy do obrazka, a liczba do wag.

## Jak liczymy warstwę porównywalną

Silnik liczb to model z v2 ([`harmonization2.py`](../backend/harmonization2.py)), bez zmian:

1. **Kontrola jakości:** tylko pożary roślinności (`type = 0`), bez detekcji o niskiej pewności i bez znanych źródeł statycznych.
2. **Kostka danych:** detekcje każdego satelity w komórkach H3 i miesiącach, osobno dzień i noc.
3. **Wydajność satelity `e`:** ile hotspotów daje dany satelita na jeden hotspot MODIS, liczone na miesiącach, gdy oba działały. Osobno dla dnia i nocy, komórki H3 i miesiąca kalendarzowego, z wygładzaniem ku regionowi i wartości domyślnej (mały obszar nie dostaje szumu). Czynniki dla er 2020–2022 i 2023+ łapią zmiany po dryfie orbit MODIS.
4. **Wynik:** `H = wszystkie hotspoty ÷ suma (e × czas pracy satelity)`, osobno w dzień i w noc. To estymator największej wiarygodności w modelu Poissona, w którym każdy satelita jest niezależnym świadkiem tej samej aktywności. Dołączenie albo wyłączenie satelity zmienia precyzję, nie poziom serii.

Dla Iberii wydajność S-NPP wynosi około 3, czyli jedna kropka S-NPP waży około 0,34 kropki MODIS.

## Co v3 dodaje do v2

| Dodatek | Po co |
|---|---|
| Flaga `small` przy każdej detekcji VIIRS i `small_layer()` | Warstwa małych ognisk do wyjaśnienia skoku (na wykresie, w legendzie, w CSV) |
| `detection_weights()` | Waga każdego hotspotu = czas obserwacji ÷ moc wykrywania. Wagi sumują się dokładnie do wyniku po **dowolnym** narysowanym obszarze i zakresie dat |
| Kolumny `weight` i `small_fire` w `/api/hotspots.csv` | Eksport wymagany w wyzwaniu, zgodny z kalendarzem |
| Niepewność kalibracji + mnożnik z walidacji | Przedziały 90% v2 pokrywały ~76% miesięcy. v3 dokłada wariancję wydajności i kalibruje mnożnik na resztach z walidacji |
| `median_stats()` | Mediana tego samego miesiąca w innych latach, „% mediany” i flaga „w normie”, gdy przedział zawiera medianę (wyzwanie mówi o „historical median”) |
| Raport warstwy progowej w `validate()` | Rok po roku pokazuje, jak daleko obrazek z progiem jest od MODIS |

## Walidacja na Portugalii: v1, v2, v3

Wspólny protokół dla wszystkich wersji: blokowy 4-fold po latach 2012–2025, model uczy się na pozostałych latach i przewiduje MODIS (Terra + Aqua) **wyłącznie z VIIRS**. Cztery regiony: Norte, Centro, Lisboa e Vale do Tejo, Alentejo e Algarve. Wartości to średnie z regionów.

| Wariant | \|Obciążenie\| 2012–2025 | Mediana błędu miesięcznego | Pokrycie przedziału 90%* | \|Obciążenie\| 2012–2019 | Błąd 2012–2019 |
|---|---|---|---|---|---|
| v1 | 6,5% | 21,4% | 0,73 | 7,2% | 19,9% |
| **v2** | **2,1%** | **21,8%** | **0,79** | **0,7%** | **19,2%** |
| **v3 (domyślne)** | = v2 | = v2 | = v2 → skalibrowane | = v2 | = v2 |
| v3 + usuwanie duplikatów MODIS | 1,5% | 23,5% | 0,77 | 1,7% | 22,9% |
| v3 + stała jednostka (kotwica S-NPP) | 6,2% | 23,9% | 0,78 | 4,8% | 23,9% |

\* Przed kalibracją mnożnika. W v3 mnożnik dobierany jest tak, żeby pokrycie wynosiło 90%.

Wnioski:
- **v2 jest najlepiej zwalidowanym silnikiem liczb**, więc v3 liczy dokładnie jak v2 i dokłada tylko funkcje, które liczb nie zmieniają.
- **Usuwanie duplikatów MODIS i stała jednostka** są w kodzie jako opcje eksperymentalne (`DEDUPE_MODIS`, `ANCHOR_UNIT`, `anchor=True`), wyłączone, bo na danych odłożonych nie poprawiły wyników.
- **Po 2023 wszystkie wersje zawyżają surowy MODIS o 12–27%** na Północy i w Centrum: VIIRS przewiduje więcej, niż MODIS widzi. To zgodne z dryfem orbit MODIS, ale żaden wariant jeszcze tego wiarygodnie nie koryguje.
- **Małe regiony są trudniejsze:** w Lizbonie (ok. 1 300 hotspotów MODIS w 14 lat) błąd miesięczny przekracza 24%.

## Jak włączyć

```bash
HARMONIZATION=v3 python -m backend serve      # v1 (domyślne) | v2 | v3
```

Przy `v3` odpowiedź `/api/calendar` ma dodatkowo serie `smallFiresPerViirsSatellite`, `otherYearsMedian`, `pctOfMedian`, `withinNormal`, a `/api/hotspots.csv` kolumny `weight` i `small_fire`. Bez zmiennej backend działa jak dotąd.

## Ograniczenia

- Progi małych ognisk (8,8 / 7,5 MW) dopasowano dla całej Iberii (2012–2018). Dla innego regionu przelicza je `fit_small_thresholds()`.
- Hotspot to piksel, a nie pożar. Brak detekcji nie oznacza braku ognia (chmury, dym, pora przelotu).
- Seria po wycofaniu MODIS (2026–2027) opiera się na wydajnościach z ostatnich lat wspólnych, w których MODIS już dryfował.

Dane: NASA FIRMS, MODIS C6.1 (MCD14ML) i VIIRS 375 m (VNP14IMGML, VJ114IMGML, VJ214IMGML), domena publiczna.
