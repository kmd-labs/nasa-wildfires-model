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
- **Po 2023 wszystkie wersje zawyżają surowy MODIS o 12–27%** na Północy i w Centrum: VIIRS przewiduje więcej, niż MODIS widzi. Test szwu względem powierzchni spalonej (niżej) nie pokazuje spadku MODIS w 2023 większego niż ok. 22%, więc dryf tej wielkości mieści się w szumie i sprawa pozostaje otwarta.
- **Małe regiony są trudniejsze:** w Lizbonie (ok. 1 300 hotspotów MODIS w 14 lat) błąd miesięczny przekracza 24%.

## Test szwu: niezależny świadek (powierzchnia spalona)

Walidacja powyżej porównuje VIIRS z MODIS, czyli dwa źródła hotspotów. Test szwu sprawdza serię wobec świadka spoza hotspotów: **powierzchni spalonej** NASA, mapowanej z odbicia powierzchni przez jedną rodzinę sensorów, więc niezmienionej w chwili, gdy do rekordu hotspotów dochodzi nowy satelita.

| Świadek | Sensor | Od | Piksel |
|---|---|---|---|
| MCD64A1 v061 | MODIS Terra + Aqua | 2000-11 | 463 m (21,5 ha) |
| VNP64A1 v002 | VIIRS S-NPP | 2012-03 | 463 m |

Dane: [`backend/burned_area.py`](../backend/burned_area.py) pobiera kafle z NASA LP DAAC dla dowolnego BBOX (token Earthdata), test: `seam_test()` w [`harmonization3.py`](../backend/harmonization3.py).

**Metoda.** Rekord dzielimy na bloki 12-miesięczne zaczynające się w miesiącu szwu i dopasowujemy jedną regresję dla wszystkich szwów naraz:

`log(hotspoty w bloku) = a + β · log(powierzchnia spalona w bloku) + Σ γ_k · po_szwie_k`

- **β ≈ 0,5** w Portugalii: hotspoty rosną jak pierwiastek z powierzchni spalonej, bo w roku megapożarów jeden hotspot przypada na dużo więcej km². Prosty iloraz „hotspoty ÷ km²” tego nie uwzględnia i dawał fałszywe alarmy, dlatego go odrzuciliśmy.
- **γ** to skok, który zostawił szew. Podajemy go w procentach z 95% przedziałem.
- **t = γ / se**: |t| ≥ 2 oznacza szew. Werdykt wymaga co najmniej 2 bloków po każdej stronie, więc dla Aqua (2002-07, tylko 1 rok wcześniej) wynik jest orientacyjny.

### Wyniki: Portugalia (4 regiony razem)

Skok serii względem świadka, w nawiasie t:

| Szew | Świadek | Suma naiwna | Zharmonizowana | Surowy MODIS |
|---|---|---|---|---|
| Aqua 2002-07* | MCD64A1 | +93% (2,6) | −12% (−0,5) | +93% (2,7) |
| **S-NPP 2012-01** | MCD64A1 | **+208% (13,2)** | −20% (−2,5) | −19% (−2,2) |
| NOAA-20 2018-04 | MCD64A1 | +28% (1,6) | −22% (−1,8) | −21% (−1,7) |
| NOAA-20 2018-04 | VNP64A1 | +38% (2,7) | −16% (−1,4) | −15% (−1,4) |
| NOAA-21 2023-03 | MCD64A1 | +68% (3,6) | +4% (0,3) | +2% (0,2) |
| NOAA-21 2023-03 | VNP64A1 | +62% (4,7) | 0% (0,0) | −3% (−0,2) |

\* Tylko 1 blok przed szwem: orientacyjnie. Suma naiwna i MODIS podwajają się, bo dochodzi drugi MODIS (Aqua); seria zharmonizowana nie.

### Wyniki: szew S-NPP w regionach (MCD64A1)

| Region | Suma naiwna | Zharmonizowana | Surowy MODIS |
|---|---|---|---|
| Norte | +212% (8,7) | −15% (−1,2) | −13% (−1,1) |
| Centro | +240% (9,1) | −8% (−0,6) | −8% (−0,6) |
| Lisboa e Vale do Tejo | +184% (5,7) | −27% (−1,7) | −29% (−1,9) |
| Alentejo e Algarve | +195% (5,0) | −22% (−1,2) | −21% (−1,1) |

Wnioski:
- **Suma naiwna ma szew S-NPP w każdym regionie** (+184% do +240%, t od 5 do 13). We wszystkich 20 testach regionalnych (4 regiony × szwy S-NPP, NOAA-20, NOAA-21 × świadkowie, tam gdzie da się policzyć) test oflagował ją 9 razy.
- **Seria zharmonizowana: 1 na 20** (Lisboa, NOAA-20 względem VNP64A1, −37%, t −2,1). Tyle fałszywych alarmów daje sam próg |t| ≥ 2 (na danych syntetycznych bez skoku ok. 7,5%).
- **Harmonizacja nie dokłada szwu ponad to, co jest w samym MODIS.** Różnica skoku serii zharmonizowanej i surowego MODIS ma medianę 3 pkt proc. i mieści się w ±7 pkt proc. w 18 z 20 testów (wyjątek: Lisboa, NOAA-20, −10 pkt proc.).
- **Spadek o ok. 20% na szwie S-NPP dla całej Portugalii widać też w surowym MODIS**, który w 2012 się nie zmienił. To więc zmiana relacji hotspotów do powierzchni spalonej (charakter pożarów po 2012), a nie efekt harmonizacji.
- **2023 (NOAA-21 i dryf MODIS):** surowy MODIS względem MCD64A1 +2% (95%: −22…+34%), względem VNP64A1 −3% (−22…+23%). Burned area nie potwierdza spadku czułości MODIS w 2023; dryf 12–27% z walidacji jest jednak poniżej progu wykrywalności tego testu.

Odtworzenie (pobiera ok. 960 kafli, kilkanaście minut):

```bash
python -m backend burned-area --bbox=-9.6,36.8,-6.0,42.2 --product MCD64A1
python -m backend burned-area --bbox=-9.6,36.8,-6.0,42.2 --product VNP64A1
```

## Jak włączyć

```bash
HARMONIZATION=v3 python -m backend serve      # v1 (domyślne) | v2 | v3
```

Przy `v3` odpowiedź `/api/calendar` ma dodatkowo serie `smallFiresPerViirsSatellite`, `otherYearsMedian`, `pctOfMedian`, `withinNormal`, a `/api/hotspots.csv` kolumny `weight` i `small_fire`. Bez zmiennej backend działa jak dotąd.

Niezależnie od wersji `/api/calendar` zwraca `seamTest`, gdy powierzchnia spalona tego obszaru jest już w cache. `/api/burned-area?bbox=…&product=MCD64A1` pobiera ją w tle (`202`, potem `200`) i oddaje miesięczne km² wraz z testem szwu.

## Ograniczenia

- Progi małych ognisk (8,8 / 7,5 MW) dopasowano dla całej Iberii (2012–2018). Dla innego regionu przelicza je `fit_small_thresholds()`.
- Hotspot to piksel, a nie pożar. Brak detekcji nie oznacza braku ognia (chmury, dym, pora przelotu).
- Seria po wycofaniu MODIS (2026–2027) opiera się na wydajnościach z ostatnich lat wspólnych, w których MODIS już dryfował.
- Test szwu wykrywa skoki od ok. 20–30% w całej Portugalii i od ok. 40–60% w pojedynczym regionie. Mniejsze skoki giną w zmienności relacji hotspotów do powierzchni spalonej.

Dane: NASA FIRMS, MODIS C6.1 (MCD14ML) i VIIRS 375 m (VNP14IMGML, VJ114IMGML, VJ214IMGML); powierzchnia spalona MCD64A1 v061 i VNP64A1 v002 z NASA LP DAAC; domena publiczna.
