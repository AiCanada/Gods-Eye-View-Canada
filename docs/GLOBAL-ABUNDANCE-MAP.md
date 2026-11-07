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
6. **FORECAST** (owner request 2026-11-07): YEARS AHEAD slides the map a
   year at a time from TODAY to `2126 · +100 YEARS`, PLAY walks it; the
   view (TYPICAL OUTCOME, IF IT GOES BADLY, IF IT GOES WELL, CHANCE OF
   ABUNDANCE, CHANCE OF SCARCITY, CHANGE FROM TODAY), the scale (AGAINST
   TODAY, AMONG THE OTHERS), the scenario (BASELINE, OPTIMISTIC,
   PESSIMISTIC, VOLATILE), the runs, CRISES and NEW DRAW; the line reads
   `SIMULATING · 43 %` then `500 RUNS OVER 100 YEARS · SIMULATED IN 2.1 S`,
   and the hindcast's line under it. **MODEL** lists what each figure's
   history gave the walk (see "The forecast").
7. **SELECTED**: the place the pointer rests on, or the one clicked (CLEAR
   lets it go): its country, its population (cities), `ABUNDANCE 72 OF 100 ·
12 OF 14 INDICATORS`, then one line per ticked indicator: the value, its
   year, its place among the others (`PLACE 87 OF 100`), where it came from
   (`FROM ITS COUNTRY`, `FROM ITS STATE OR PROVINCE`, `YOUR CSV`) and the
   measure. The same lines are the card on the globe when a place is clicked.
   At a future year the lines are the forecast's (below), with the place's
   fan chart under them.
   The coloured fill takes no clicks itself, so every layer under it (street
   level photo lines, roads, rail) stays clickable: a dot is picked as
   itself, another layer's object under the pointer comes first, and
   otherwise the place is the country or state the pointer's point on the
   globe falls in (the photorealistic tiles count as the ground). The fill
   draws nothing in Cesium's pick pass either: an unpickable classification
   primitive still draws there in Cesium 1.138, as nothing, and would wipe
   the picks of the ground layers drawn before it. It sits in the ground
   collection, under the other ground layers.
8. **RANKING**: MOST ABUNDANT or LEAST ABUNDANT, ten rows; a row click keeps
   that place selected. At a future year the rows carry the view's figure.
9. **ABUNDANCE GRID** (when ticked): the links, `Québec → Nunavut · GAP 61 ·
1,234 KM`; at a future year, from the typical outcome.
10. **DATA**: each source family with its series, when it was fetched and
    what failed; REFRESH DATA, LOAD CSV, CLEAR CSV and the line about the
    loaded CSV (`YOUR CSV · 12 ROWS · 10 MATCHED · COLUMNS NOT USED: colour`).

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

Each source is fetched for its thirty latest values (`mrnev=30` at the World
Bank, the thirty latest years of an Our World in Data CSV) and the OECD's
fifteen (`lastNObservations=15`: most of its regional series start around
2000, and each query carries every region of a level). A figure's change is
measured against the newest value at least five years older (else the oldest
kept, when it is three or more years older), and rides after the year in the
readout and on the card: `▲ +2,500 SINCE 2019`, `▼ -3.2 SINCE 2018`, `■ 0.0
SINCE 2020` for no change. A figure handed down from a state or country keeps
its change. The whole history behind a figure feeds the forecast (below): the
server sends, with each figure, its trend `g`, swing `s`, steps `n` and mean
`m` in the indicator's own walking space (`src/abundanceForecast.mjs`,
`seriesStats`), and a figure handed down carries the history of the place it
came from.

The World Bank has answered `mrnev=6` with one value per country while the
same series asked by years held them all (inflation and forest area,
2026-10-23). A World Bank answer one value deep is asked again for the last
thirty years (`date=1996:2026`) and the two are joined, the thirty latest
kept; when that second request fails the first answer stands alone.

## The forecast

A Monte Carlo of every place's abundance 0 to 100 years ahead (owner request
2026-11-07: "create monte Carlo simulator for future abundance (0-100 years),
use fine grain detail and display on map", then "try for more advanced future
abundance predictions"). Every figure walks forward a year at a time from its
own history, on hundreds of runs; the score of each run at each year is summed
up as the place's 10th, 50th and 90th percentiles, its mean and the chances it
is abundant (75 or over) or scarce (25 or under), the grid's thresholds, on
two scales: against today's figures, and among the other places in that year.

**How a figure walks.** Each indicator has a process (`FORECAST_PROCESSES`);
a walking family is pulled toward a moving frontier:

| Family  | Indicators                                                                                                                                 | The walk                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| growth  | GDP PER PERSON, INCOME; a city's GREEN SPACE (m² per person)                                                                               | in logs; the frontier is the 90th percentile of today's places and moves at the scenario's long-run growth (1.5 % a year in the baseline); money is projected in today's dollars (2.5 % a year of dollar inflation, the US GDP deflator over 1996–2026, taken off its trend) |
| floor   | HEALTH (floor 1 per 1,000), SAFETY (0.1 per 100,000), AIR (2 µg/m³), SHARE IN PRISON (5 per 100,000)                                       | in the log of the distance above the floor; the frontier is the 10th percentile and improves 1 % a year (deaths), 0.5 % (crime, air), not at all (prison)                                                                                       |
| ceiling | LIFE SPAN (100 years), EDUCATION (160 % gross; 100 % for the OECD's tertiary share), INFRASTRUCTURE, UTILITIES, WATER, GREEN SPACE (100 %), HAPPINESS (10) | in logits below the ceiling; the frontier is the 90th percentile and moves 0.01 to 0.02 logits a year; a share already at 100 % stays there                                                                                           |
| revert  | WORK, COST OF LIVING (in logs), INFLATION (as it is)                                                                                       | pulled back toward its own usual level, a quarter of the distance a year for unemployment, a tenth for the price level, a third for inflation                                                                                                   |

Each year a walking figure moves by the frontier's drift plus `beta` of its
gap to the frontier (1.5 % of the gap a year for money, 2 % for deaths, life
span and schooling, 3 % for the internet and electricity, less for the slow
ones), plus its residual trend: what its history did beyond that
(`seriesStats`: the latest steps weighing most, a step twelve years back
half), shrunk toward the level's typical residual as if the typical were four
more steps of history, bounded at ±6 % a year, and fading with a half-life of
30 years (money) or 40 (the rest), with the hindcast's trend shift for the
indicator (below) riding and fading with it. So a fast-growing poor place
keeps growing fast for a while and converges in the long run, and a rich one
above the frontier is pulled gently back to it. The swing is the history's
standard deviation of a year's change (a gap of several years counted as its
square root), shrunk the same way, kept between a quarter and four times the
level's typical (itself never below the indicator's assumed swing: a source
that interpolates between its surveys, as the water and forest series do,
shows no swing from year to year), and scaled by the hindcast (below).

**The swings move together.** A year's swing is a world shock, a country
shock, a place shock and the figure's own, in shares set per indicator (money:
20 % world, 25 % country, 30 % place; unemployment much the same; life span,
schooling and the shares of people a few per cent each; forest and prison
almost none), each with a sign: good times lift GDP, income, life span,
schooling and happiness and lower unemployment, child deaths and homicides. So
a province's GDP and income rise and fall together, its cities with it, every
place of a country with the country, and the world's places a little with the
world. A country-level series' place shock is its country's, which its
provinces' and cities' own figures share.

**Crises are regimes.** Each run carries a world chain, and each place its
own: a normal year turns to crisis with a chance of 6 % (world) or 3 %
(place), a crisis year stays one with a chance of 35 % (30 %), each crisis
year cuts money by 3–6 % (2–6 %), and three recovery years follow, each giving
back 1.2 % (1 %). Each indicator has an exposure to a cut in its own space:
money 1, unemployment −8 in logs (a 6 % cut raises it by about half), life
span 2 and happiness 0.5 in logits, child deaths and homicides −0.5 in logs,
the rest 0. The trends were measured over years that had their crises, so the
chain's mean impulse (`regimeMeanImpulse`) is given back as drift: with
CRISES on, the typical path is the trend's and the bad case is worse; with it
off, the bands are narrower.

**Scenarios.** BASELINE; OPTIMISTIC (the frontier grows 2.5 % a year, the
other frontiers move half again as fast, crises come half as often);
PESSIMISTIC (0.5 % a year and half the pace, crises twice as often); VOLATILE
(crises twice as often and half again as deep).

**Two scales.** AGAINST TODAY: a future figure is measured on today's places
(`placeTable`: a figure equal to one of today's gets its place among them,
ties sharing their mean, one between two a place between theirs, one past the
ends 0 or 100, reversed where lower is better), so a place's year-0 score is
the ranking's own, 100 is the best any place has today, and the map can turn
greener as the world grows. AMONG THE OTHERS: on each run and year every
indicator's places are ranked against each other (512 bins over the year's
range), each weighed by its population, a place's rank the share of people in
places behind it (its own bin counted half), and the weighted mean of a
place's ranks is its score; the people average 50 every year, and the map
shows who is ahead. The chances are of a
run's score; RANKING sorts by the view's figure on the scale shown, and the
grid links by the typical outcome against today. The ranks cost about as much
as the walk, so they are computed when that scale is chosen.

**The world's people.** Every place carries its people (`people`): a
country's population from the World Bank (`SP.POP.TOTL`, else its populated
places' people together), a state's or province's its country's shared out
(nine tenths by the people of its Natural Earth populated places, one tenth
equally, so a province with no populated place still counts), a city's own
Natural Earth population; a place with none weighs as the median of the known
(`peopleOf`). The ranks among the others weigh by them, and so does the world
line under the FORECAST controls: `ALL PLACES BY POPULATION · ABUNDANCE 48 OF
100 TODAY → 55 IN 2051 · 49 TO 61 IN 8 OF 10 RUNS · IN ABUNDANT PLACES 12 % →
18 % · IN SCARCE ONES 30 % → 21 %` (at TODAY, the three figures alone): on
each run the people-weighted mean score against today and the shares of
people in abundant (75 or over) and scarce (25 or under) places, summed up
over the runs as the score's 10th, 50th and 90th percentiles and the mean
shares (`simulate`'s `world`, read by `worldAt`). Where no place has people
(a CSV level), every place counts once and the line says so (`ALL PLACES,
EACH COUNTED ONCE`). The frontier, the typical history and the hindcast stay
per place: the leading edge and a model's error do not depend on how many
live there.

**The hindcast.** When a level is built, the server takes each figure's
history as it stood ten years before the newest figure (`buildUnits(level, {
upTo })`), builds the plan for each indicator alone and measures today's
figure on that past's yardstick (money deflated to the past's dollars). First
the trends: each distinct series' trend path (`trendPath`: the walk with no
swings and no crises, the mean path) is run from the past to today, its miss
in the walking space is divided by how far one unit of trend a year would have
moved that path (the path probed with 1 % more), and the median of those over
the level's series, shrunk as if ten more figures had missed nothing and kept
within 0.4 of the indicator's typical swing a year (2 % a year for money, a
point a year for inflation), is the indicator's trend shift: what the decade
said the model's trends missed, added to every series of the indicator and
fading with the residual (a returning indicator's usual level moves by it).
Then the swings: the replay with the shift (twelve years, 100 runs) gives each
figure a band, and from the standardised errors comes the swing scale that
would make the 10th-to-90th band hold about 8 of 10 (the 80th percentile of
the errors over the normal's 1.28), between a half and ten; the replay again
with both gives the share held (a share at its ceiling holds when today's
figure is still within the ceiling's zone, 99.5 % of it or more), and the
server reports `{ from, to,
indicators: { id: { tested, held, scale, shift } }, tested, held }` with
each level's table. The tab passes the shifts and scales to every run
(`buildPlan`'s `shifts` and `scales`), reads `HINDCAST 2014→2024 · THE
8-OF-10 BAND HELD 81 % OF 2,345 FIGURES · THE TRENDS AND SWINGS ARE
CALIBRATED BY IT` under the FORECAST controls, and each MODEL line ends `·
SWING ×1.3 · HINDCAST TREND -210 $ A YEAR · HINDCAST BAND HELD 82 %` (the
shift's part of the typical year's change, in the figure's units; left out
when there is none). An indicator with fewer than ten figures to test is left
out. Synthetic levels in `src/abundanceForecast.test.mjs` hold most figures
after the calibration, and a decade that bent every trend by 3 % a year gets
a shift of that sign, within the bound, that halves the trend paths' miss. On
the real figures (2026-11-07, 2016→2026) the band held 86 % of the countries'
2,848 figures, 87 % of the states' and provinces' 61,931 and 88 % of the
cities' 96,566, 80–94 % for every indicator but unemployment (72–80 %, the
decade of the pandemic), with swing scales between 0.7 and 4.4; the water and
forest shares, whose sources interpolate between surveys and revise whole
series, hold 80–91 % only because the assumed swing floors their histories'.

**The runs.** 100, 250, 500, 1,000 or 2,000 (500 for countries, 100 for the
other levels until the owner picks; a city level runs about twenty thousand
distinct series, since a province's or country's figure handed down is one
series for every place that took it, and those places move together). The
simulation runs in a Web Worker (`src/abundanceForecast.worker.js`, driven by
`src/abundanceForecastRun.js`), so the globe keeps turning; a change to the
ticks, weights, runs, crises, scenario, scale or draw waits 300 ms and then
runs again, and a newer run replaces the one in flight. Every random number is
a hash of the series' or place's key, the run and the year (`draw`), with
the seed NEW DRAW advances: the same choice gives the same map, and a place's
detail, simulated on its own with the same world, country and place draws, is
the map's own row for it against today. A country level of 500 runs takes
about three seconds, a region or city level of 100 runs about five, or twelve
with the ranks among the others (`src/abundanceForecast.test.mjs` holds the
smaller numbers).

**What SELECTED and MODEL read.** At a future year a place reads `2051 ·
ABUNDANCE 64 OF 100 TYPICALLY · 48 TO 79 IN 8 OF 10 RUNS`, then `AMONG THE
OTHERS IN 2051 · 61 OF 100 TYPICALLY · 50 TO 72` when the run ranked them,
`CHANCE OF ABUNDANCE 31 % · CHANCE OF SCARCITY 2 %` and `RANKED 12 OF 198 ·
+12 FROM TODAY` on the scale shown, then one line per ticked indicator with
the typical figure, its 10th to 90th percentile band and the place that figure
stands at against today (`GDP PER PERSON · 38,500 $ · 31,000 TO 48,000 ·
PLACE 71 OF 100 · FROM ITS COUNTRY`), and the fan chart of its score over the
century (the band, the typical line, the abundant and scarce marks, the chosen
year). MODEL reads, for the selected place (else the level's typical figures),
each indicator's walk in its own units: `GDP PER PERSON · +1,010 $ A YEAR ·
±2,501 $ · CATCHING UP WITH THE FRONTIER (66,056 $) · 28 STEPS OF HISTORY ·
SWING ×1.3 · HINDCAST TREND -210 $ A YEAR · HINDCAST BAND HELD 82 %`,
`HEALTH · -0.3 A YEAR · ±0.6 · TOWARD
THE FRONTIER (2.2), FLOOR 1.0 · …`, `WATER · … · TOWARD THE FRONTIER
(100 %), CEILING 100 % · …`, `INFLATION · 0.0 % A YEAR · ±2.5 % · RETURNS TO
ITS USUAL 3.0 % · …`, `UTILITIES · … · AT ITS CEILING, STAYS THERE`, a CSV
figure `NO HISTORY: THE LEVEL'S TYPICAL FIGURES`.

**What it is not.** The walks are statistical, not a model of the world's
economy: no place's growth depends on another's except through the frontier
and the shared shocks, a crisis has no cause, and the frontiers' pace, the
pulls, the shares, the exposures and the chains are assumptions written in
`src/abundanceForecast.mjs`, as are the floors and ceilings; the hindcast
calibrates the trends and swings against one decade, within bounds, not the
model's shape. The hundred-year horizon is there
because the owner asked for it; the bands say how little a century of walking
pins down.

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
| (the people: the forecast's weights, no indicator) | `SP.POP.TOTL` population, total (else the populated places' people together) | the country's, shared out: nine tenths by the populated places' people, one tenth equally | Natural Earth `pop_max` |

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
| `GET /data?level=` | `country`, `region` or `city`: the units and their figures, one array per indicator (`v`, `year`, `from`, the change `d` since `y0`, and the history's `g`, `s`, `n`, `m` for the forecast) |
| `POST /refresh`    | `{ force? }`: fetch the stale sources again, or all; the tab polls `/status` |
| `POST /import`     | `{ level, csv }`: the owner's figures for a level (4 MB at most)           |
| `DELETE /import`   | `{ level }`: take that CSV away (refused on the phone)                     |

Every answer goes gzipped to a client that accepts it (`Content-Encoding:
gzip`, `Vary: Accept-Encoding`; the states' 2.5 MB of JSON travels as 0.19 MB,
the cities' 4.1 MB as 0.35 MB), and the units carry only what the tab reads (id, name, country,
code, place and population), not the alternative names and larger regions
the server matched sources by. A level request that gets no answer (the
dev server between two restarts, the tailnet link down) is said on the
status line in the tab's words, `NO ANSWER FROM THE SERVER · TRYING AGAIN
IN 5 S`, and tried again after 5, 10, 20, 40, then 60 seconds; a status
poll that fails leaves a loaded level alone and comes back sooner than the
idle poll; a page served in place of the figures counts as no answer.

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
| `src/abundanceForecast.mjs`            | the forecast: the processes, a history's stats, the plan, the simulation, a place's detail, the worker's protocol |
| `src/abundanceForecast.worker.js`      | the worker that carries the forecast's messages                        |
| `src/abundanceForecastRun.js`          | the runner: the worker, or the handler inline                          |
| `server/shared/abundanceData.mjs`      | fetching, caching, joining, handing down, the owner's CSV              |
| `server/providers/abundance.js`        | the routes                                                             |
| `scripts/build-admin-packs.mjs`        | `--only places` builds the populated places pack                       |
| `src/tooling/abundance.test.mjs`, `src/abundancePanel.test.mjs`, `src/abundanceOverlay.test.mjs`, `src/abundanceForecast.test.mjs`, `src/abundanceForecastRun.test.mjs` | the tests |

The strings are in Spanish, Quebec French, Inuktitut and Ancient Egyptian
([I18N.md](I18N.md), "The fork's own tabs"). The hand checks are in
[TESTING.md](../TESTING.md), section 10.
