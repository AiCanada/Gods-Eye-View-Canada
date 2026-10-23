# Global Abundance Map

The left-hand tab under AI Distillation that colours the globe by how
abundant each place is (owner request, 2026-10-22: "create new tab on
dashboard called Global Abundance Map … Global abundance grid, idea to
replace resource scarcity with algorithmic orchestration … use de-centralized
global scale optimization layer that looks at physical assets and reroutes as
needed … display Global abundance on MAP … Use GDP per person, Life Span,
Health, Income, Inflation, Expense/Cost, Education, Infrastructure, % in
Prison, Utils, Happiness, ect. to help measure Abundance … by
country/state/province/city, all or just selected indicators").

## What the tab holds

1. **Status**: one line: the level, how many places have figures, the newest
   year of data and when the sources were fetched; while a refresh runs,
   `FETCHING THE SOURCES · 7/24 · OECD DF_GDP …`.
2. **INSTRUCTIONS**: the short steps, folded; this file is the full guide.
3. **LEVEL**: COUNTRIES, STATES AND PROVINCES or CITIES. **SHOW ON MAP**
   colours the globe; **ABUNDANCE GRID** draws the links (below).
4. **INDICATORS**: ALL, then one tick per indicator. Each row says what it
   measures at this level and how many places have a figure of their own
   (`198 OWN FIGURES · 2024`, or for states `12 OWN FIGURES · 4,500 FROM
THEIR COUNTRY · 2025`).
5. **LEGEND**: the ramp, scarce (red) through amber to abundant (green); a
   place with no figure for any ticked indicator is grey.
6. **SELECTED**: the place the pointer rests on, or the one clicked (CLEAR
   lets it go): its country, its population (cities), `ABUNDANCE 72 OF 100 ·
12 OF 14 INDICATORS`, then one line per ticked indicator: the value, its
   year, its place among the others (`PLACE 87 OF 100`), where it came from
   (`FROM ITS COUNTRY`, `FROM ITS STATE OR PROVINCE`, `YOUR CSV`) and the
   measure. The same lines are the card on the globe when a place is clicked.
   The coloured fill takes no clicks itself, so every layer under it (street
   level photo lines, roads, rail) stays clickable: a dot is picked as
   itself, another layer's object under the pointer comes first, and
   otherwise the place is the country or state the pointer's point on the
   globe falls in (the photorealistic tiles count as the ground). The fill
   draws nothing in Cesium's pick pass either: an unpickable classification
   primitive still draws there in Cesium 1.138, as nothing, and would wipe
   the picks of the ground layers drawn before it. It sits in the ground
   collection, under the other ground layers.
7. **RANKING**: MOST ABUNDANT or LEAST ABUNDANT, ten rows; a row click keeps
   that place selected.
8. **ABUNDANCE GRID** (when ticked): the links, `Québec → Nunavut · GAP 61 ·
1,234 KM`.
9. **DATA**: each source family with its series, when it was fetched and what
   failed; REFRESH DATA, LOAD CSV, CLEAR CSV and the line about the loaded
   CSV (`YOUR CSV · 12 ROWS · 10 MATCHED · COLUMNS NOT USED: colour`).

## The score

Each indicator places every unit of the level among the others, 0 (the least
abundant) to 100 (the most), the way abundance lies for it: the highest
income scores 100, the highest inflation 0. Ties share their mean place. The
abundance score is the mean place over the ticked indicators the unit has a
figure for, each counted by its weight; a unit with none is grey and ranks
nowhere. One indicator alone colours the map by that indicator's places.

## Weights

Every INDICATORS row has a slider, ×0.5 to ×3 by halves (×1 by default), so
HEALTH can count double and INFLATION half. The score is the weighted mean
of the places; the row reads `×2` beside the slider, an unticked row's
slider is off, and RESET WEIGHTS puts every weight back to ×1. The weights
are kept in this browser with the rest of the choice.

## The legend

With one indicator ticked the legend reads real figures: the figure behind
the red end (the scarcest: the lowest, or the highest where lower is better,
as for inflation), the median behind amber, and the figure behind the green
end, in the indicator's units (`1,200 $ · 12,345 $ · 120,000 $`). With more
than one ticked it reads the score, 0 · 50 · 100.

## Trends

Each source is fetched for its six latest values (`mrnev=6` at the World
Bank, `lastNObservations=6` at the OECD, every year of an Our World in Data
CSV). A figure's change is measured against the newest value at least five
years older (else the oldest kept, when it is three or more years older), and
rides after the year in the readout and on the card: `▲ +2,500 SINCE 2019`,
`▼ -3.2 SINCE 2018`, `■ 0.0 SINCE 2020` for no change. A figure handed down
from a state or country keeps its change.

The World Bank has answered `mrnev=6` with one value per country while the
same series asked by years held them all (inflation and forest area,
2026-10-23). A World Bank answer one value deep is asked again for the last
fifteen years (`date=2011:2026`) and the two are joined, the six latest kept;
when that second request fails the first answer stands alone.

## Larger regions

The states pack carries each unit's larger region (`group`: Natural Earth's
region, or for the United Kingdom the constituent country and the English
region). An OECD region that names no unit (Scotland, Hungary's Northern
Great Plain, a French région for its départements, an Italian regione for
its province) gives its figure to every unit inside it that has none of its
own, marked `FROM ITS LARGER REGION` and counted apart in the INDICATORS
rows; a small region whose name lists places (`Hartlepool and
Stockton-on-Tees`, `Armagh City, Banbridge and Craigavon`, `Kensington &
Chelsea and Hammersmith & Fulham`) gives its figure to each place it names.
A list name is matched by name only, never by its first words, so its figure
never lands on its first place alone, and a large region's list name
(`Castile and León`, `Oslo and Viken`) is a larger region, never one of its
places' own figure. An urban area named after two places is one city:
found by its first name (`Brighton and Hove`), else by the places it names
(`Cheshire West and Chester`). The alias table in `src/abundanceUnits.mjs`
settles the OECD's English names against the pack's local ones (Piedmont,
Andalusia, Brittany, Greater Lisbon).

A zero for GDP PER PERSON, LIFE SPAN, INCOME, EDUCATION or AIR is no figure:
the OECD writes 0 for a region it has none for (tertiary education in about
half its small regions, 3,479 of 6,982 values on 2026-10-23), so such a
place takes its larger region's or its country's figure. A zero where it can
be real (no homicide, no infant death in a small region that year) stands.

## The indicators and their sources

| Indicator          | Countries (World Bank WDI unless noted)                      | States and provinces (OECD regional database, TL2 then TL3) | Cities (OECD functional urban areas) |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------ |
| GDP PER PERSON     | `NY.GDP.PCAP.PP.CD` GDP per capita, PPP                      | `DF_GDP` GDP per capita, USD PPP                            | `DF_ECONOMY` GDP per capita, USD PPP |
| LIFE SPAN          | `SP.DYN.LE00.IN` life expectancy at birth                    | `DF_LIFE_EXP` life expectancy at birth                      | from the state or country            |
| HEALTH (lower is better) | `SH.DYN.MORT` under-5 mortality per 1,000               | `DF_STATUS` infant mortality per 1,000                      | from the state or country            |
| INCOME             | `NY.GNP.PCAP.PP.CD` GNI per capita, PPP                      | `DF_INC` disposable income per capita, USD PPP              | from the state or country            |
| INFLATION (lower)  | `FP.CPI.TOTL.ZG` consumer prices, % a year                   | from the country                                            | from the country                     |
| COST OF LIVING (lower) | `PA.NUS.PRVT.PP` ÷ `PA.NUS.FCRF`: the price level against the USA | from the country                                    | from the country                     |
| EDUCATION          | `SE.SEC.ENRR` secondary enrolment, % gross                   | `DF_ATTAIN` adults 25–64 with tertiary education, %         | from the state or country            |
| INFRASTRUCTURE     | `IT.NET.USER.ZS` people using the internet, %                | from the country                                            | from the country                     |
| SHARE IN PRISON (lower) | Our World in Data `prison-population-rate` (World Prison Brief) | from the country                                      | from the country                     |
| UTILITIES          | `EG.ELC.ACCS.ZS` access to electricity, %                    | from the country                                            | from the country                     |
| WATER              | `SH.H2O.BASW.ZS` basic drinking water, %                     | from the country                                            | from the country                     |
| HAPPINESS          | Our World in Data `happiness-cantril-ladder` (World Happiness Report) | from the country                                   | from the country                     |
| SAFETY (lower)     | `VC.IHR.PSRC.P5` homicides per 100,000                       | `DF_SAFETY` homicides per 100,000                           | from the state or country            |
| WORK (lower)       | `SL.UEM.TOTL.ZS` unemployment, % of the labour force         | `DF_RATES` unemployment, % of the labour force aged 15–64   | `DF_LABOUR` unemployment in the urban area |
| AIR (lower)        | `EN.ATM.PM25.MC.M3` fine particles (PM2.5) breathed, µg/m³   | from the country                                            | `DF_POLLUTION` release 1.2: PM2.5 breathed in the urban area, µg/m³ |
| GREEN SPACE        | `AG.LND.FRST.ZS` forest, % of the land                       | from the country                                            | `DF_GREEN_AREA` green space in the urban centre, m² per person |

The cities' PM2.5 comes from the OECD's release 1.2 of `DF_POLLUTION`
(2021–2023), not its newest, 1.5 (released 2026-10-09, 2021–2025), which is
corrupt: every 2023 value is near zero, for every urban area and all four
pollutants (PM2.5, PM10, NO₂, ozone), and its 2021 and 2022 values are not
1.2's for the same city and year but 1.2 to 4.9 times them (2.9 at the
median; Halifax 32.2 against 7.0, Edmonton 65.4 against 12.5, London 30.3
against 10.9, Mexico City 131.0 against 25.4). Release 1.2 holds steady
from year to year (2023: London 10.7, Paris 12.6, Berlin 12.3, Halifax 8.3,
Edmonton 17.4 in its wildfire summer). Its latest year is 2023 and its
first 2021, too close for a change over five years. When the OECD corrects
the newer release, the version in `src/abundanceCore.mjs` moves to it.

Every OECD answer is checked before it is used: a release whose figures
collapse in a year (that year's median over its areas below a twentieth of
the other years', exact zeros left out, since the OECD writes 0 where it has
no figure) is refused. The source then shows as failed in DATA and the last
good answer stays in use. Each cached answer is kept with the URL it
answered, and an answer to another URL (another release, key or query) is
not read, so a change of release takes effect at once.

Every figure is the latest value the source has, with its change over five
years (see Trends). A state or province without a figure of its own takes its
country's; a city takes its state's, else its country's; every figure says
where it came from, and the INDICATORS rows count both. The sources are
listed in [DATA_SOURCES.md](../DATA_SOURCES.md): World Bank WDI (CC BY 4.0),
Our World in Data (CC BY 4.0), OECD (its terms of use, attribution), Natural
Earth (public domain).

Where the OECD names a region the Natural Earth pack does not (Japan's ten
large regions, the UK's ITL regions, Switzerland's seven), the small regions
(TL3: prefectures, départements, provinces, cantons) are tried next; what
still matches nothing is left out, and the place takes its country's figure.
The matching is by name (folded, then without the generic words, then an
alias table in `src/abundanceUnits.mjs`).

## The places

Every place comes from the bundled Natural Earth packs
(`src/data/local_data/natural_earth/`): 256 countries (admin-0, type
Country), 4,587 states and provinces (admin-1) and 7,342 populated places.
Each has a stable id the server and the globe share: a country's ADM0_A3
code (`CAN`), a state's ISO 3166-2 code (`CA-ON`), a city's Natural Earth
id. Countries and states are drawn as ground polygons (classified onto the
terrain and the photoreal tiles), cities as dots sized by population.

## The abundance grid

A first model of the owner's orchestration layer. With ABUNDANCE GRID ticked,
every scarce place (a score of 25 or under) is linked to its nearest abundant
one (75 or over), the scarcest first, up to sixty links; each is drawn as an
arc on the globe and listed with its gap and distance. Nothing is moved or
priced: the grid shows where abundance sits nearest to scarcity, the way a
decentralised layer would look at physical assets before rerouting them.

## Your own figures

LOAD CSV takes a CSV file for the current level. The header names the place
(`id` with a unit id, or `name` with `country`, an ISO code or the country's
name), an optional `year`, then one column per indicator by id (`gdp`,
`life`, `health`, `income`, `inflation`, `cost`, `education`,
`infrastructure`, `prison`, `utilities`, `water`, `happiness`, `safety`,
`work`) or by its English label (`GDP PER PERSON`). Columns it does not know
are listed back. The file is kept as `.gev-data/abundance/<level>.csv` and
its figures go on top of the sources (`YOUR CSV` on the line); CLEAR CSV
takes it off. On the owner's phone CLEAR CSV does nothing and says nothing,
as every removal does.

## The AI World tab

TRAIN ON has a GLOBAL ABUNDANCE row (class OPEN). Ticked, each day's run
writes the countries' places among the others, 0 to 1, per indicator and as
their mean, for every place of the latest world by its country:
`.gev-data/demographics/abundance-<worldId>.npy` (float32 [n, 17]) and
`.json` (the channels), beside the demographics; the Python reader attaches
them to the world as `abundance` and `abundance_columns`
([WORLD-MODEL-DATA.md](WORLD-MODEL-DATA.md)). The DEMOGRAPHICS delete scope
removes them with the rest of that folder.

## The routes

`/api/abundance` (server/providers/abundance.js; the figures in
server/shared/abundanceData.mjs):

| Route              | What                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `GET /status`      | the sources (when each was fetched, rows, error), each level's coverage    |
| `GET /data?level=` | `country`, `region` or `city`: the units and their figures, one array per indicator |
| `POST /refresh`    | `{ force? }`: fetch the stale sources again, or all; the tab polls `/status` |
| `POST /import`     | `{ level, csv }`: the owner's figures for a level (4 MB at most)           |
| `DELETE /import`   | `{ level }`: take that CSV away (refused on the phone)                     |

The raw answers are kept thirty days in `.gev-cache/abundance/`; a source
that fails is not asked again for an hour, and OECD requests are spaced ten
seconds apart (it allows 60 downloads an hour per address and refuses
bursts). Every request asks for English (`Accept-Language: en`): Node's
fetch otherwise sends `accept-language: *`, which the OECD answers with HTTP
500 for a labelled CSV, while the same URL from curl, which sends none,
answers. The first open of the tab starts the first fetch;
until it ends the map is grey and the status line says what is being
fetched.

## Files

| File                                   | What                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `src/abundanceCore.mjs`                | the indicators and sources, the score, colours, ranking, links, CSV   |
| `src/abundanceUnits.mjs`               | the places from the packs, their ids, the name matching                |
| `src/abundanceShapes.js`               | the packs decoded for the globe                                        |
| `src/abundancePanel.js`                | the tab                                                                |
| `src/abundanceOverlay.js`              | the globe: polygons, dots, arcs, the card, the picks                   |
| `server/shared/abundanceData.mjs`      | fetching, caching, joining, handing down, the owner's CSV              |
| `server/providers/abundance.js`        | the routes                                                             |
| `scripts/build-admin-packs.mjs`        | `--only places` builds the populated places pack                       |
| `src/tooling/abundance.test.mjs`, `src/abundancePanel.test.mjs`, `src/abundanceOverlay.test.mjs` | the tests |

The strings are in Spanish, Quebec French, Inuktitut and Ancient Egyptian
([I18N.md](I18N.md), "The fork's own tabs"). The hand checks are in
[TESTING.md](../TESTING.md), section 10.
