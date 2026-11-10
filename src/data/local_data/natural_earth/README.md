# Natural Earth packs

Offline named-region polygons for the voice-annotation resolver
(`src/data/naturalEarthRegions.js`) — "outline the Alps" resolves to the real
range geometry with no network dependency.

| File | Source dataset | Features |
|------|----------------|----------|
| `regions.json` | `ne_10m_geography_regions_polys` (ranges, deserts, plateaus, peninsulas, islands, …) | 1,046 named |
| `marine.json` | `ne_10m_geography_marine_polys` (seas, gulfs, straits, bays, …) | 292 named |
| `countries.json` | `ne_10m_admin_0_countries` (countries) | 256 |
| `states_provinces.json` | `ne_10m_admin_1_states_provinces` (states, provinces and other first-level units) | 4,587 named |
| `places.json` | `ne_10m_populated_places_simple` (cities and towns, points only) | 7,342 |
| `admin1_population.json` | Wikidata, population (P1082) of the states and provinces above (CC0, not Natural Earth) | 3,785 items + 61 codes + 163 names |

**Source:** Natural Earth 10m physical vectors, via the canonical
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
GitHub repo, commit `ca96624a56bd078437bca8184e78163e5039ad19` (fetched
2026-07-28T01:36:39Z — exact provenance is in each file's `meta` header).

**License:** public domain (https://www.naturalearthdata.com/about/terms-of-use/).
No attribution legally required; we credit "Made with Natural Earth" anyway.
See DATA_SOURCES.md.

**Curation** (script not committed — parameters recorded in `meta.curation`):

- Named features only; the `Dragons-be-here` joke feature ("Null Island") dropped.
- Outer rings only (holes are irrelevant at country-scale outline zoom).
- Douglas-Peucker simplification at 0.01°, coordinates rounded to 3 decimals
  (~110 m), rings stored open (no closing duplicate vertex).
- MultiPolygon crumbs under 20 km² dropped (largest part always kept);
  rings that survive with fewer than 8 distinct vertices are midpoint-densified
  (shape-identical) so every ring has ≥8 vertices.
- Zero-area sliver artifacts dropped. Two marine features are ONLY slivers in
  the source and are therefore absent: **Drake Passage** and **Luzon Strait**.
- Result: 7.3 MB source → 2.5 MB pack (budget ≤3 MB, enforced by
  `src/data/naturalEarthRegions.test.mjs`).

Duplicate names exist upstream (two "Cordillera Oriental", a sliver + real
"Canadian Shield", …); the lookup module resolves ties by largest area.

## States and provinces (`states_provinces.json`)

Worldwide first-level administrative units for area annotations ("outline
Texas", "outline Bavaria"), read by `src/data/adminBoundaries.js`.

**Source:** `geojson/ne_10m_admin_1_states_provinces.geojson` from
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
at commit `ca96624a56bd078437bca8184e78163e5039ad19` (SHA-256
`22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5`), fetched
2026-09-25. `geojson/ne_10m_populated_places_simple.geojson` from the same
commit (SHA-256
`fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f`) is read
only to mark ambiguous names; none of it is bundled.

**License:** public domain, as above.

Each unit also carries `group`, the larger region it sits in (Natural Earth's
`region`; for the United Kingdom the constituent country and, in England,
the English region), so the GLOBAL ABUNDANCE MAP can hand an OECD region's
figure to the units inside it (`src/abundanceUnits.mjs`, `findGroup`).

**Regenerate:** `node scripts/build-admin-packs.mjs --only admin1` downloads
the pinned files (to the system temp directory, or `--cache <dir>`), checks
their SHA-256 and rewrites the pack byte for byte. Parameters are in the
script's `PARAMS` and in the pack's `meta.curation`.

**Schema:** `meta` (source, URLs, hashes, license, curation, `population`:
the snapshot the people came from) and `features[]`
with `name`, `nameEn` (when it differs), `alt[]` (Latin-script `name_alt`
variants and abbreviations), `postal`, `type` (`type_en`), `rank`
(`min_label`), `country` (`admin`), `iso2`, `iso` (ISO 3166-2), `pop` (the
unit's people from `admin1_population.json`, below; 4,008 units), `amb[]`,
`ambAbroad[]`, `cityState`, `label` ([lon, lat] label point) and
`polygons`. `polygons` is a list of parts, largest first, each
`[outer, ...holes]`; every ring is open and stored as integers in units of
10^-3 degrees (10^-`d` when a feature carries `d`), the first vertex absolute
and each later one as a `[dLon, dLat]` delta.

**Curation:**

- The 7 unnamed features and 2 degenerate Nauru districts are dropped
  (4,596 → 4,587).
- Douglas-Peucker per ring at 0.004 × √(unit area in km²) km, clamped to
  0.005°–0.02° (Texas ≈ 0.02°, Bavaria ≈ 0.01°); coordinates rounded to
  3 decimals. The 75 units too small to survive (Maldives atolls, Malta's
  councils) keep 4 decimals at 0.001° (`d: 4`); 3 smaller still (Vatican
  City) keep their source rings at 5 decimals (`d: 5`).
- Parts under 20 km² or under 0.03% of the unit's largest part are dropped;
  holes under 20 km² are dropped. Outers are counter-clockwise, holes
  clockwise.
- `amb` lists names that are also a country (`admin`/`geonunit` of any
  unit), a populated place of 200,000+ (`pop_max`) inside the unit's box
  when the unit is larger than 1,000 km², or a populated place of 50,000+
  elsewhere in the same country; `ambAbroad` lists names shared only with a
  populated place of 50,000+ in another country. `cityState` marks a unit of
  at most 1,000 km² that contains its namesake city (Berlin, Vienna, Paris).
  548 units carry `amb`, 108 `ambAbroad`, 138 `cityState`.
- Result: 3,748,185 bytes with the people (3,648,916 without); 6,492 parts,
  80 holes, 407,339 vertices.

## The states' and provinces' people (`admin1_population.json`)

Wikidata's population of each unit above, the weight the GLOBAL ABUNDANCE
MAP gives a state or province among the others and in the world's line
(`server/shared/abundanceData.mjs`, `peopleOfRegions`). Not Natural Earth's
data: **Wikidata**, whose data is **CC0 1.0**
(https://creativecommons.org/publicdomain/zero/1.0/); no attribution legally
required, "Wikidata" credited anyway.

**Source:** property P1082 (population), every statement but the deprecated,
asked of the SPARQL service (https://query.wikidata.org/sparql) by the
unit's own Wikidata item (Natural Earth's `wikidataid`, when no other named
unit carries it: 4,254 items, 3,785 with a figure), else by its own ISO
3166-2 code through P300 (asked for the 501 units whose item gives no
figure, 61 with one: Belgium's Luxembourg province, Mount Athos's monastic
community, Vava'u's division, Latvia's municipalities of 2009–2021), else by
its name among its country's units (677 asked, 163 with a figure; below).
Of an item's statements the best-ranked (the preferred when there are any,
else the normal) with the latest point in time (P585) wins, the larger on
one date — unless that figure is one and a half times or more, or two
thirds or less, of the median of the item's dated figures of the fifteen
years before, one of them within five years: a count cannot move so far
without the unit's bounds moving or a slip in the data, so the latest figure
before the jump stands, for the polygon as Natural Earth drew it (42
figures; `meta.jump`: Wikidata's Cebu and Bohol carry each other's 2024
counts, Kuala Lumpur's 2025 figure is its metro area's, L'Aquila's 2024 is a
slip, Vietnam's provinces merged in 2025 carry the merged counts dated 2024
on the old items, Makati's and Taguig's 2024 counts follow a boundary moved
in 2023; Papua's and West Papua's 2024 figures, which fit Natural Earth's
undivided polygons, give way to the 2022 ones). An item the service has no
triples for at all (British Columbia, Prince Edward Island and Newport in
Wales in November 2026) is asked of the Wikidata API (`wbgetentities`); an
item without a population that one item replaced (P1366) and that replaced
it alone (P1365) takes that successor's figure (3: the provinces of Turin,
Naples and Florence, whose metropolitan cities succeeded them one for one);
a unit whose own item was replaced by several, more than one of them drawn
nowhere by Natural Earth (the old Kasaï-Oriental, split in three), or
dissolved (P576) with no successor known (Moyen-Cavally), is asked by
neither code nor name, what bears its name now not being the unit drawn (40
units; Oman's Ash Sharqiyah, drawn as North and South under the old region's
id, is asked, the South being the one successor left). Set aside (13): an
item whose own ISO 3166-2 codes are all another country's (8: Belgium's
Luxembourg province given the Grand Duchy's canton, three Kosovo districts
given Serbia's Kosovo and Metohija, Crimea and Sevastopol under Russia with
Ukraine's codes, Jersey, Sint Eustatius), and a region or province keyed to
a unit of a city kind (5: Natural Earth's Manila carries Metro Manila's id,
its Davao and Zamboanga their regions', its Cebu and Iloilo city features
their provinces'); a set-aside unit is then asked by code or by name, which
finds Luxembourg's province, Crimea's republic and Sevastopol by code,
Sint Eustatius's own item, Kosovo's municipalities and the five Philippine
cities by name, and a city-kind unit that finds no city of its name keeps
its key (Suðurnes, a region Natural Earth types a town). Fetched 2026-11-10
(UTC; `meta.fetched`).

**By name:** a unit without a figure by item or code is matched among its
country's units on Wikidata that have a population: those located in the
country or in a unit located in it (P131, two steps; the query written from
the country outward with the planner held to that order, as left to itself
it scans every population statement there is and times out), and those
named like the unit anywhere in the country or its sovereign state (P17: the
Philippines' component cities sit in provinces in regions, Ireland's cities
in counties in provinces, the Cook Islands' islands are located in nothing).
Natural Earth's name, English name, local name and GeoNames name count,
each alone and with the unit's kind ("Lima Region", "Province of Turin"),
the GeoNames name weighing a little less when it alone hits (it is now and
then a neighbour's); its alternate and Yahoo names do not, as for many units
they name the region above (Rimini's say "Emilia Romagna"). Labels and
aliases are read in English, the language-neutral "mul" label many items
carry alone, and the countries' own languages, with the countries' words
for the kind folded away ("Rēzeknes novads", "Sha`biyat al Wahat", the
Arabic article). A candidate must be of the unit's kind by its classes
(P31: a city for a city, an administrative unit for the rest — never a bare
settlement; a city that is also a unit of the level stands by that class,
as The Valley is Anguilla's capital and one of its districts), not a unit
inside a unit of the level (Libya's towns inside its districts), not an
item that holds another of the country's units drawn apart from it (Lima's
department, with Lima Province beside it), and at the level of the
country's keyed units of that kind: of a class most of them carry (one
keyed to a comune does not make Italy's capital comuni its provinces), else
of any class the keyed units have, or, with none keyed, of a class with
members enough in the country for the units of that kind and not three
times too many (Kosovo's thirty units are its municipalities, not its seven
districts nor its villages), or, with none keyed and nothing located in the
country, of any (the Cook Islands). An exact label beats one with the
administrative words folded away, an exact label naming the kind ("Lima
Province") a bare one, a label of the unit's kind one of the other, a unit
directly in the country one a step down; a tie at the top is no match. An
item two units of one country name goes to the one GeoNames names as
Natural Earth does — the other polygon is a neighbour's, mislabelled:
Natural Earth's second "Uruzgan" is Daykundi, its second "Parwan" Panjshir,
its second "Mbarara" Kiruhura — else to neither; units of two countries
may each name one item (Sevastopol under Russia and under Ukraine: a
figure weighs within its country alone); a unit beaten to an item, or
denied one for naming it with another, tries again among the items no unit
named (the Daykundi, Panjshir and Kiruhura polygons find their own items;
North and South Tipperary, both naming County Tipperary, find their ridings
inside it). A unit alone in its country is not asked: the server gives it
the country's people. Of the 677 asked in 85 countries, 163 are figured:
the Philippines' 39 cities and provinces (Natural Earth's Manila carried
Metro Manila's 14.0 million, now its own 1.9), Kosovo's 28 municipalities,
Hong Kong's 18 districts, Anguilla's 14 districts, Ireland's 12 (the
counties, their cities, Tipperary's ridings), Åland's 11 municipalities,
the Cook Islands' 6 inhabited islands, Latvia's 6 municipalities of
2009–2021, Afghanistan's 4, Lima Province among the rest. Of the 514 left,
about 450 have their own Wikidata item but Wikidata holds no population
for it (most of Italy's provinces, Burkina Faso's, Sri Lanka's and Malawi's
districts, Madagascar's regions but Sava's), and the rest name items the
rules refuse (Italy's comuni for its provinces, Libya's towns for its
districts, Lima's department) or none at all. What a figure carries over
from Natural Earth's 2022 map is in docs/GLOBAL-ABUNDANCE-MAP.md.

**Regenerate:** `node scripts/build-admin-packs.mjs --only population`
asks Wikidata again (SPARQL in batches of 250 a second apart, the codes only
where the item gives no figure, the API for the items the service leaves
unanswered, an identifying `User-Agent`, a longer wait after a refusal or
an answer cut short; about half an hour)
and rewrites the snapshot; `--only admin1` then carries it into the states
pack as `pop`, leaving out a figure dated before 1990
(`meta.curation.population.minYear`). The default run never asks Wikidata,
so the packs stay reproducible.

**Schema:** `meta` (source, endpoint, api, the units file and its hash,
fetched, license, `jump` — the factor, years and memory of the jump rule —
and the count set aside) and `items` ({Wikidata item: [population, year or
null, the one item that replaced it when the figure is that successor's]}),
`codes` ({ISO 3166-2 code: [population, year or null, Wikidata item]}, the
units figured by their code alone) and `names` ({Natural Earth `adm1_code`:
[population, year or null, Wikidata item]}).

## Countries (`countries.json`)

Natural Earth 10m admin-0 countries, public domain under the terms above.
Source: `geojson/ne_10m_admin_0_countries.geojson` at the same pinned commit;
SHA-256 `239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255`.
Regenerate with `node scripts/build-admin-packs.mjs --only countries`.
Uses the state/province encoding and simplification, retaining parts of at least
20 km² and 0.003% of the largest part (including Alaska and Hawaii); the largest
part always stays. Holes under 20 km² are dropped.
Includes England, Scotland, Wales and Northern Ireland from
`ne_10m_admin_0_map_units.geojson` at the same commit (SHA-256
`57da82be755f4afccd8f3b14251bb2752f5df1395f47d2d86f817470c4a48862`).
Result: 945,843 bytes; 260 features, 2,088 parts, 122,788 vertices.

## Populated places (`places.json`)

Every Natural Earth 10m populated place as a point, for the GLOBAL ABUNDANCE
MAP's city level (owner request 2026-10-22), read by `src/abundanceUnits.mjs`
and `src/abundanceShapes.js`: `id` (Natural Earth's own `ne_id`, the unit id
the server and the globe share), `name`, `alt` (ASCII, alternate and
megacity names), `country`, `iso` (ADM0_A3), `iso2`, `adm1` (the state or
province name), `lon`, `lat` (3 decimals), `pop` (`pop_max`), `capital` (a
national capital) and `rank` (`scalerank`). No polygons, so the pack stays
small (1.1 MB).

**Source:** `geojson/ne_10m_populated_places_simple.geojson` from the same
commit (SHA-256
`fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f`); the
countries file above supplies an ISO 3166-1 alpha-2 code where a place has
none.

**Regenerate:** `node scripts/build-admin-packs.mjs --only places`.
