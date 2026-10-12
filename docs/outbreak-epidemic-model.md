# Outbreak epidemic model

The EPIDEMIC MODEL in the Outbreak box is a stochastic metapopulation
simulation (`src/outbreakEpi.mjs`, run by the server at
`POST /api/outbreak/epidemic`). It is a scenario tool for exploring what-ifs,
not a forecast of real cases. The file header of `src/outbreakEpi.mjs` is the
source of truth for every mechanism and its citation; this page summarises the
compartments, the options, the outputs and the sources.

## Compartments

Every place keeps a count of people in each state:

| State | Meaning                                                                             |
| ----- | ----------------------------------------------------------------------------------- |
| `S`   | susceptible                                                                         |
| `E`   | latent (infected, not yet infectious)                                               |
| `P`   | presymptomatic infectious                                                           |
| `Is`  | symptomatic infectious                                                              |
| `Ia`  | asymptomatic infectious                                                             |
| `H`   | in a general hospital ward                                                          |
| `U`   | in intensive care                                                                   |
| `R`   | recovered or otherwise immune (the pre-immune and the vaccine-protected start here) |
| `D`   | dead                                                                                |

People in the air (`inTransit`), waiting for a bed (`pendingAdmit`) and
removed by screening, quarantine or arrival detection (`isolated`) are counted
too, so every hour of every run

```
Σ (S + E + P + Is + Ia + H + U + R) + deaths + inTransit + pendingAdmit + isolated = Σ N
```

Deaths stay in a place's population `N`; the hazard keeps dividing by it.

## The hourly step and its draws

The loop is hourly: `DT = 1/24` day, every rate is per day and every per-step
probability is `1 − exp(−rate × DT)`. Four kinds of random draw exist:
binomial (who moves between states), Poisson (seeding and spillover), gamma
(each infectious person's infectiousness, giving superspreading) and a bare
uniform (which onward flight a transfer takes). Where an option is at its
neutral value, its code path makes **no draw**, so the random stream of every
unset option is identical to the model without it.

The exception is the hospital pathway: every pathogen preset now sets a
hospital stay, so a profile built from a preset runs the hospital path. Only a
profile with "Hospital stay (days)" blank runs the older instantaneous death
draw.

## Options and their neutral values

Each control is in the Outbreak box; its profile key is what the server and the
export carry. The first option of every menu is the neutral one.

### Pathogen

| Control                                          | Key                  | Range or options                                                      | Neutral     | Effect                                                                                                                                                                                                                                            |
| ------------------------------------------------ | -------------------- | --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hospital stay (days)                             | `hospitalDays`       | 1–60                                                                  | blank       | mean ward stay; set by every preset (novel 8, flu 5, covid2020 8, omicron 5, measles 5, sars2003 20, mers 15, ebola 10, mpox 10, dengue 5, h5n1 14)                                                                                               |
| Intensive care (% of hospitalised)               | `icuPct`             | 0–100                                                                 | 0           | share of admissions that need intensive care (mean ICU stay `ICU_DAYS` = 10)                                                                                                                                                                      |
| Admission delay (days)                           | `admitDelayDays`     | 0–14                                                                  | 0           | days from the end of symptoms to admission                                                                                                                                                                                                        |
| Immunity wanes after (days)                      | `waningDays`         | 0–3650                                                                | 0           | mean days until a recovered person is susceptible again (0: never); reinfections are counted                                                                                                                                                      |
| Variant emergence                                | `variants`           | Steady drift · A fitter strain takes over · Second strain (set below) | drift       | takeover: a logistic rise in transmissibility, midpoint day 30, scale 5 days, advantage by mutation rate (0, 0.4, 0.7); second strain: real second-strain compartments from the six fields below, with no drift and no takeover (see Two strains) |
| Second strain starts (day)                       | `strain2Day`         | 0–40                                                                  | blank (14)  | day the second strain is seeded, at hour 24 × day from the window start (day 0 is the first day)                                                                                                                                                  |
| Second strain seed cases                         | `strain2Cases`       | 1–100000                                                              | blank (10)  | people seeded with the second strain, split over the seed places like the first strain's cases                                                                                                                                                    |
| Second strain airport code                       | `strain2Place`       | 3–4 letters or digits                                                 | blank       | where it is seeded; an IATA code or the airport table's code, kept upper-case. Blank, or a code that is not a place of this run: the outbreak places                                                                                              |
| Second strain transmissibility (% of first)      | `strain2Pct`         | 10–300                                                                | blank (150) | transmissibility relative to the first strain                                                                                                                                                                                                     |
| Second strain severity (% of first)              | `strain2SeverityPct` | 10–500                                                                | blank (100) | hospitalisation and death risk relative to the first strain                                                                                                                                                                                       |
| Cross-immunity (% of first-strain immunity kept) | `crossImmunityPct`   | 0–100                                                                 | blank (50)  | share of first-strain immunity (recovered, pre-immune, vaccinated) that also protects against the second strain                                                                                                                                   |

The six second-strain fields do nothing unless Variant emergence is "Second
strain"; the value in brackets is what a blank field means then. Under any
other mode a profile that sets them gives the same result as one that does not.

### Human behaviour and demographics

| Control                             | Key                  | Range or options                              | Neutral  | Effect                                                                                                 |
| ----------------------------------- | -------------------- | --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| Susceptibility variation            | `heterogeneity`      | None · Moderate (CV 1) · High (CV 2)          | none     | gamma-distributed susceptibility; herd immunity at `1 − R^(−1/(1 + CV²))`                              |
| Commuting mixing                    | `mixing`             | Home only (one way) · Daytime two-way         | home     | daytime: commuters also carry infection back, pushed from each infected place to its destinations      |
| Commuting concentrated in daytime   | `commuteDaySplit`    | 0.5–1                                         | 0.5      | share of daily commuting between 7 and 19 local; 0.5 is flat                                           |
| Departure clock                     | `clock`              | UTC hours · Local hours                       | utc      | local: pattern flights leave at the origin's local hour (longitude heuristic)                          |
| Airport transfers                   | `transfers`          | None · Some connecting passengers · Hub heavy | none     | a share of arrivals at a large airport fly on after a layover (15 % / 3 h, 30 % / 2 h)                 |
| Response signal                     | `responseSignal`     | Reported cases · Deaths · Both                | reported | what the public reacts to                                                                              |
| Response reach                      | `responseReach`      | Own place · Mixed · Everywhere                | local    | whether a place reacts to its own numbers, the run's total, or their mean                              |
| Awareness fatigue (days to halve)   | `fatigueDays`        | 0–180                                         | 0        | the public's caution halves over this many days, down to a floor of 0.3                                |
| Vaccinated at the start (%)         | `vaccinatedPct`      | 0–100                                         | 0        | prior coverage; `coverage × protection` of the population starts immune and R falls by the same factor |
| Vaccine protection (%)              | `vaccineEfficacyPct` | 0–100                                         | 0        | all-or-nothing protection against infection; blank means 70 % when a campaign is set                   |
| Domestic flights (% of normal)      | `travelDomesticPct`  | 0–300                                         | 100      | passenger factor on flights inside a country                                                           |
| International flights (% of normal) | `travelIntlPct`      | 0–300                                         | 100      | passenger factor on flights between countries                                                          |

### Interventions

| Control                                         | Key                     | Range or options                                                                                                                  | Neutral    | Effect                                                                                                                                           |
| ----------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interventions end after (days)                  | `interventionDays`      | 0–40                                                                                                                              | 0          | length of the intervention window (0: never ends)                                                                                                |
| Local trigger                                   | `triggerMode`           | Everywhere at the start hour · Reported cases per 100,000 · Hospital load                                                         | everywhere | per-place restrictions switch on when a place reaches the trigger and off below half of it                                                       |
| Case trigger (reported per 100,000 in 7 days)   | `triggerPer100k`        | 0–500                                                                                                                             | 0          | threshold for the reported-cases trigger (0: never)                                                                                              |
| Bed trigger (% of beds full)                    | `triggerBedShare`       | 0–100                                                                                                                             | 80         | threshold for the hospital-load trigger                                                                                                          |
| Minimum restriction (days)                      | `minLockDays`           | 1–28                                                                                                                              | 14         | a triggered restriction lasts at least this long                                                                                                 |
| Restriction fatigue (days to halve compliance)  | `fatigueHalfDays`       | 0–180                                                                                                                             | 0          | compliance halves over this many days, down to a floor of 0.4                                                                                    |
| Lockdown reach                                  | `lockdownScope`         | Everyone (household too) · Outside the home only                                                                                  | all        | outside the home only: household contacts keep mixing and rise a quarter under lockdown                                                          |
| Border policy                                   | `borderPolicy`          | Every flight · Flights out of the outbreak countries · Flights out of countries reaching the trigger · Every international flight | none       | which legs the travel restriction, screening and quarantine apply to                                                                             |
| Border trigger (reported cases in the country)  | `borderTrigger`         | 1–100000                                                                                                                          | 10         | reported cases that flag a country under the reaching-the-trigger policy                                                                         |
| Detection of arriving cases                     | `importDetection`       | Off · Low · Medium · High                                                                                                         | off        | share of symptomatic arrivals found, reported and isolated (0, 0.2, 0.5, 0.8)                                                                    |
| Testing capacity (tests per 1,000 people a day) | `testsPer1000Day`       | 0–50                                                                                                                              | 0          | reports above the daily capacity are lost; the place counts as saturated                                                                         |
| Vaccination starts (day)                        | `vaccineStartDay`       | 0–40                                                                                                                              | blank      | campaign start, days after the window start                                                                                                      |
| Vaccination pace (doses per 1,000 people a day) | `vaccinePer1000Day`     | 0–50                                                                                                                              | 0          | campaign pace; protection arrives 14 days after the dose                                                                                         |
| Vaccination cap (% of people)                   | `vaccineCoverageMaxPct` | 0–95                                                                                                                              | 70         | coverage the campaign stops at                                                                                                                   |
| Vaccination priority                            | `vaccinePriority`       | Everywhere · Outbreak places first                                                                                                | everywhere | outbreak places first: other places start 14 days later                                                                                          |
| Compare against                                 | `compare`               | Nothing · No interventions · No travel measures · No lockdown or tracing · No vaccination campaign                                | none       | runs the same scenario a second time with that set of measures taken away and reports what the measures did (see Comparison with fewer measures) |

### Epidemic model row

| Control          | Key / id                      | Meaning                                                                                 |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| Random seed      | `seed` (`#outbreak-epi-seed`) | 0–4294967295; blank ("auto") derives one from the inputs. Any profile change clears it. |
| DOWNLOAD RESULTS | `#outbreak-epi-download`      | the last result as JSON (`exportedAt`, `request`, `result`)                             |
| DOWNLOAD CSV     | `#outbreak-epi-csv`           | the places table and the day-by-day totals as two CSV blocks                            |

## Outputs

Hours are hours after the window start; `null` means later than the window or
fewer than half the runs. Medians are over runs; a per-place median counts the
runs that never reached the place as zeros.

### `places[]` (every place with a chance of arrival)

| Field                                                                                | Meaning                                                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `id, code, name, kind, lat, lon, population, origin`                                 | the place                                                                                          |
| `pArrive`, `pArriveCi`                                                               | chance the infection arrives and its 95 % Wilson interval                                          |
| `arrivalHours[21]`, `arrivalGiven[21]`                                               | arrival percentiles 0..100 step 5, overall and given arrival                                       |
| `etaP5, etaP50, etaP95`, `etaP50Ci`                                                  | arrival window and the interval on its median                                                      |
| `pReported`, `reportP5, reportP50, reportP95`                                        | chance and timing of the first report                                                              |
| `pOverwhelmed`, `overflowP50`                                                        | chance the beds run out and the median hour they do                                                |
| `casesP50, casesP95`, `deathsP50`                                                    | cumulative infections and deaths                                                                   |
| `hospitalPeakP50`, `icuPeakP50`                                                      | peak ward and intensive-care occupancy                                                             |
| `pRestricted`, `restrictP50`                                                         | chance a local restriction triggers and the median hour it does                                    |
| `importedP50`, `pImportedFirst`, `pGround`, `pLocal`, `localBy50`, `establishedBy50` | imported cases; whether the first case flew in or came by ground; local spread and ten-case timing |
| `vaccinatedP50`, `reinfectedP50`                                                     | people protected by the campaign; reinfections                                                     |
| `pTestsSaturated`                                                                    | share of runs in which testing capacity was exceeded                                               |
| `pStrain2`                                                                           | share of runs in which the second strain infected someone here (two strains only)                  |
| `byDay[]`                                                                            | per day `[pAny, pTen, meanCases]` for origins and the 100 likeliest places (`byDayPlaces`)         |
| `localOffsetHours`                                                                   | the place's hour offset from UTC (longitude heuristic)                                             |

### `totals[]` (one entry per day)

`p5, p50, p95` (infected), `newP5, newP50, newP95` (new infections a day),
`reportedP5/50/95`, `deathsP5/50/95`, `hospitalP5/50/95` (ward occupancy),
`icuP50`, `admittedP50`, `bedsShortP50`, `restrictedPeopleP50`,
`restrictedPlacesP50`, `vaccinatedP50`, `countriesClosedP50`, `importedP50`,
`reinfectedP50`, `distancingP50`, and always `rtP5, rtP50, rtP95` (Rt in the
runs, 2 dp, `null` on day 0, on a partial last day and when fewer than half
the runs have a value).

With two strains: `strain2P50` (cumulative second-strain infections) and
`strain2ShareP50` (the median, over the runs with new infections that day, of
the second strain's share of them; `null` when fewer than half the runs had
any). With a comparison: `counterfactualP50` (infected in the comparison arm)
and `avertedP50` (the median paired difference, comparison minus main), both
`null` on every day when no pair ran.

### `summary`

| Group                            | Fields                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproduction                     | `r0, rEffective, rFactors, rControlled, doublingDays, doublingControlledDays, establishment, establishmentSeeds, k, rEnd, coverageEnd, hitShare, heterogeneityCv, householdShare`                                                                                                                        |
| Size                             | `infectedP50, infectedP95, infectedP50Ci, reportedP50, reportedP95, reportedP50Ci, deathsP50, deathsP95, deathsP50Ci, ascertainment, reportDays, immuneEndP50, reinfectedP50, vaccinatedP50, pExtinct`                                                                                                   |
| Hospital                         | `hospitalP50` (cumulative admissions), `icuP50, peakHospitalP50, peakIcuP50, placesOverwhelmed, overflowRuns, overflowDayP50, bedDaysShortP50`                                                                                                                                                           |
| Peak                             | `peakDayP5, peakDayP50, peakDayP95, peakNewP50, peakNewP95, peakReached`                                                                                                                                                                                                                                 |
| Restrictions                     | `placesRestricted, restrictedPersonDaysP50, restrictedPersonDaysP95, passengersBlockedP50, travellersCaughtP50, countriesClosedP50, countriesReached`                                                                                                                                                    |
| Travel                           | `importedP50, importedShare, firstDetectedAbroadP50, transfersFlown, testsSaturatedPlaces`                                                                                                                                                                                                               |
| Ensemble                         | `mcRelHalfWidth, runsSuggested, runTimeMs (only when partial), runsFit`                                                                                                                                                                                                                                  |
| Rt                               | `rtLastDay` (1-based, the last day with an Rt in most runs, or `null`), `rtLastP50` (its median, or `null`), `generationDays` (the mean generation interval of the kernel, 1 dp)                                                                                                                         |
| Second strain (two strains only) | `strain2Day` (0-based), `strain2Place` (the matched place's code, or `''` for the outbreak places), `strain2Seeded`, `rStrain2`, `strain2InfectedP50`, `strain2ShareEnd`, `takeoverRuns`, `takeoverDayP5, takeoverDayP50, takeoverDayP95` (1-based, `null` when fewer than half the runs had a takeover) |

The top level also carries `startMs, untilMs, hours, runs, runsAsked, partial,
seed, places, commutes, totals, summary, byDayPlaces` and, from the server,
`sensitivity`: a one-at-a-time tornado over the main inputs (each at two thirds
and one and a half times its value) with the R and doubling time each gives.

Two more top-level fields appear only when they apply:

- `stoppedAt: { run, hour }`, when the time limit cut a run. The model reads
  the clock every `ABORT_CHECK_HOURS` = 6 simulated hours against a deadline
  the server sets 65 s after the worker starts (8 s under its hard stop of
  73 s). A cut run 0 is kept, truncated at that hour, and the result has one
  run; line 2 then says "(time limit: one run, stopped at day N)" and the
  status says "time limit: stopped at day N of M (try fewer days)". A cut later
  run is dropped, so the result is exactly that of the runs before it. `hours`
  stays the requested window. With no deadline the clock is never read inside
  a run.
- `counterfactual`, when Compare against is set (see Comparison with fewer
  measures).

Every value is finite or `null`, so the result survives JSON unchanged. The
CSV's totals block gains `rtP5, rtP50, rtP95, strain2P50, strain2ShareP50,
counterfactualP50, avertedP50` as its last columns (empty when absent); the
places block is unchanged and `pStrain2` rides in the JSON export only.

## The cost ledger

- **Person-days of restriction** are unweighted: every person in a restricted
  place counts one per day, whatever the lockdown level or compliance.
- **The distancing index** is contact-weighted: the population-weighted share
  of contacts removed across the affected places on that day, so it falls with
  compliance fatigue while person-days do not.
- **Passengers blocked** counts the passengers the travel restriction kept off
  flights; **travellers caught** counts people removed by screening, quarantine
  and arrival detection; **bed-days short** sums the patients without a ward or
  intensive-care bed, hour by hour.

## Two strains

With Variant emergence set to "Second strain", a second strain runs in its own
compartments `E2, P2, Is2, Ia2` beside the first. Both strains share `S`,
`R`, the wards, deaths, reports, awareness, restrictions and the testing cap,
as surveillance would; `Rx`, a part of `R`, holds the people whose immunity
is first-strain type (recovered from the first strain, pre-immune or
vaccinated). Linear drift and takeover are off (drift is 1). `R0`, `R now`
and `rEffective` keep describing the first strain at day 0.

- **Seeding.** At hour `24 × strain2Day`, if that is inside the window, at the
  place whose code matches the airport code (the server maps an IATA code to
  the table code), else at the outbreak places:
  `max(1, round(cases / places))` people per place move from `S` to `E2`. No
  draw is made for the second strain before then, so every run is identical
  to the one-strain run up to that hour.
- **Hazard.**
  `λ2 = hazard(Wp2 × presymKeep + Ws2 × (1 − iso) + Wa2 × asymRelative) × rel`,
  with the same contacts, restrictions, caution, season and commuting as the
  first strain.
- **New infections.** One shared draw `fresh ~ Bin(S, 1 − e^(−exposure))` on
  the summed pull of both strains, then `fresh2 ~ Bin(fresh, pull2 / pull)`
  go to the second strain and the rest to the first.
- **Escape.** `Bin(Rx, 1 − e^(−(1 − cross) × pull2 × step))` people with
  first-strain immunity catch the second strain anyway; they count as
  reinfections and take no susceptibility variation (that describes the
  never-infected pool).
- **Severity.** The admission share is `min(1, hospitalShare × severity)`;
  with no hospital stay the death risk is
  `min(1, fatality × severity × (1 + overflow))`. Ward and intensive-care
  discharges return to `Rx` in proportion to the first strain's share of
  admissions (an expected-value split, no draw).
- **Status-based immunity** (Gog & Grenfell 2002): recovery from the second
  strain protects against both, so its recovered never catch the first strain.
- **Travel.** Flights and hub transfers carry both strains, with the same
  screening and arrival detection; symptomatic travel uses the first strain's
  share.

The box's closed form is
`rStrain2 = rel × R(susceptibleShare = σs + (1 − cross)(1 − σs))`: the second
strain meeting the starting immunity at day 0 (with `rel` 1 and `cross` 1 it
equals `rEffective`). A run's takeover day is the first day from `strain2Day`
on when the second strain causes at least half the day's new infections. The
line after Peak reads "Second strain: from day D at PLACE · R x · N % of
infections by the end · took over on day D (5–95 %: a–b)", or "took over in
N % of runs" when fewer than half the runs had a takeover, or "Second strain:
not seeded inside the window (day D)". Where both strains circulate a
place-hour costs about 1.8 times as much; a run seeded late or never costs
about the same as one strain.

## Comparison with fewer measures

Compare against runs the same scenario twice: the main arm A as set, and arm B
with one set of measures taken away. Nothing else changes between the arms.

| Set                     | Taken away                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| No interventions        | travel restriction, exit and entry screening, quarantine, lockdown, contact tracing, arrival detection and the vaccination campaign |
| No travel measures      | travel restriction, exit and entry screening, quarantine and arrival detection                                                      |
| No lockdown or tracing  | lockdown and contact tracing                                                                                                        |
| No vaccination campaign | the vaccination campaign                                                                                                            |

Every set keeps the testing capacity (a limit, not a measure), prior
vaccination, the awareness response, the triggers, the border policy and the
flights as a share of normal (they describe the scenario). R with interventions
is worked out again for arm B (`counterfactual.rControlled`).

- **Common random numbers.** Run `r` of both arms draws from the same
  substream (`seed + r × RUN_STRIDE`), so the arms are identical draw for draw
  until the first draw that the removed measures change, at the intervention
  start at the earliest. The seeding and early chain history, where most of
  the run-to-run spread comes from, cancel in the paired difference
  `Δ_r = X_B,r − X_A,r` (positive: the measures helped). Because binomial and
  Poisson draws use a variable number of uniforms, the streams drift apart
  after that; the paired variance is still no larger than the unpaired one in
  expectation (Glasserman 2003 §4.1; Kleijnen 2015), and the gain is largest
  when the interventions start late.
- **Budget.** Arm A gets half the run budget and arm B runs as many runs as A
  did with the rest, skipping the per-place tables. A world that fits 200 runs
  gives about 100 pairs. `runsFit` counts what both arms fit; `partial` is
  set when fewer pairs than main runs finished. When the time limit cut arm A,
  arm B is skipped.
- **Output.** `counterfactual` is
  `{ compare, label, runs, rControlled, infectedP50, deathsP50, peakHospitalP50, averted }`,
  where `runs` is the number of pairs, the three medians are arm B's, and
  `averted` holds `infectedP5/P50/P95, infectedCi, deathsP5/P50/P95, deathsCi,
peakHospitalP5/P50/P95, peakHospitalCi, reportedP50`: the run-to-run spread
  of Δ and the Monte-Carlo interval on its median. When no pair ran it is just
  `{ compare, label, runs: 0, cut: true, rControlled }`.
- **Line.** After the Cost line: "All measures vs none (N paired runs): X
  fewer infections (5–95 %: a–b) · Y fewer deaths · hospital peak Z fewer
  patients". The other sets read "Travel measures vs none", "Lockdown and
  tracing vs none" and "Vaccination campaign vs none", and a negative
  difference reads "more". When no pair ran: "Comparison skipped: the time
  limit was reached before the comparison could run". The status adds "N
  paired runs × 2 arms" and the curve draws arm B's infected.

## Rt in the runs

`R now` (`rEffective`) is the profile's static figure at day 0. "Rt in the
runs" is read from what the runs did, the way surveillance estimates it (Cori
et al. 2013; Gostic et al. 2020; Wallinga & Lipsitch 2007). So it includes
restrictions, fatigue, awareness, season, susceptibility variation, both
strains, commuting, imports and the campaign without repeating their logic. It
costs no draw: it is computed once after the ensemble.

- **The generation kernel** is read off the model's own hourly stage chain for
  one person infected in hour 0, with `qs = e^(−σ DT)`, `qr = e^(−ρ DT)`,
  `qg = e^(−γs DT)` and `qa = e^(−γa DT)`. Each hour `E` leaves at `1 − qs`
  (a share `asymShare` to `Ia`, the rest to `P`), `P` moves to `Is` at
  `1 − qr`, and `Is` and `Ia` shrink by `qg` and `qa`. The infectiousness
  at hour `j` is `k_j = P + (1 − iso) Is + asymRelative × Ia`, normalised to
  `hourly`, for up to `RT_KERNEL_DAYS_MAX` = 60 days. For an infection at a
  uniform hour of its day,
  `w_s = (1/24) Σ_u Σ_{j: ⌊(u + j)/24⌋ = s} hourly[j − 1]` (day 0 kept:
  same-day transmission). `generationDays` is its mean.
- **The estimator**, per run, on the day's new infections `I_d`:
  `Λ_d = Σ_{s=0}^{min(d, Smax)} w_s I_(d−s)` and `R_d = I_d / Λ_d` when
  `d ≥ 1` and `Λ_d ≥ RT_MIN_INFECTIOUS` (10), else `null`.
- **Bands.** Per day, the 5th, 50th and 95th percentiles over the runs with a
  value, when at least half the runs have one; a partial last day is `null`.
  The Peak line ends with " · Rt in the runs X on day D (5–95 %: a–b)" for the
  last day with a value, and the curve draws Rt with a dashed Rt = 1 line.
- **Limits.** The kernel takes the base isolation and no contact tracing, so
  tracing inside the window makes the true kernel slightly shorter. Seeds and
  spillover enter the incidence with no infectors. The first days are `null`.

## Rail travel (owner ruling 2026-10-12)

Owner request, 2026-10-12: "find all rail on globe, and make sure to include
in outbreak sim". Travellers by train join the places the world rail network
connects. These are scenario rates for exploring, not a forecast.

- **The network.** Every rail line on the globe is built once, in the
  background, from OpenStreetMap rail (ODbL) in OpenMapTiles vector tiles from
  OpenFreeMap. The zoom-8 tiles of every land tile are used (about 20,000;
  Antarctica and everything south of 60° S are left out). The joins are the
  same as for the rail round an outbreak location: crossings, loose ends up to
  200 km, and separate networks up to 200 km. Until it is built, the model runs
  as before and says `railSource: 'pending'`.
- **Places.** A city of any size within `RAIL_REACH_KM` (30 km) of the world
  rail is a place, however far it is from an airport (`buildEpidemicNodes`,
  `railNear`). This only adds places; it never removes one.
- **Volume.** Each country's rail passenger-km a year comes from the World
  Bank WDI `IS.RRS.PASG.KM`, "Railways, passengers carried (million
  passenger-km)", latest year (CC BY 4.0, kept 30 days). It covers about 120
  countries, some with old years or pandemic years. A country with no figure
  takes its continent's median passenger-km per km of line, times its own km
  of line on the world network, and is listed in `railEstimated`.
- **Pairs.** Zipf's P1P2/D (Zipf 1946, "The P1P2/D hypothesis: on the
  intercity movement of persons", American Sociological Review 11:677-686,
  which was fitted on rail passengers): `T_ij ∝ P_i P_j / D_ij`. `D` is the
  distance along the rail, not the straight line. A pair across a border is
  damped by the commuting model's factor, `COMMUTING.crossBorder` (0.3).
- **Scaling.** Per country of origin, so that `Σ T_ij D_ij` equals its
  passenger-km a year divided by 365. A pair less than 1 km apart along the
  rail counts as 1 km.
- **Every pair once, by cell.** Places are grouped by 1° cell, country and
  separate rail network. Each pair of places is counted once, at the coarsest
  cells that still keep the two apart (well-separated cells that double in
  size up to 64°, as in Greengard & Rokhlin 1987). So every rail place sends
  and receives its whole share, and the route list is the size of the cells,
  not of every pair of places. A cell's trips leave from and arrive at its
  biggest rail place; the commuting links carry them on locally. `D` is the
  rail distance between those places, along the network of places whose
  shares of the rail touch (a network Voronoi diagram). Trips inside one cell
  are left to the commuting model.
- **Timing.** Trains leave between 06:00 and 22:00 local time. Each route
  takes one hourly slot, chosen by a stable hash, on the local clock as the
  air routes do. A trip takes `D / speed`, where the speed is the box's train
  speed (`speedKmh` in the request, 60 km/h by default).
- **In the run.** Rail routes go through the same hourly boarding as daily
  flights: the travel share, the border policy, the ban, screening and
  quarantine all apply. A fraction of a passenger a day is rounded up or down
  at random by the fraction (only for rail, so the air results do not move).
  Rail never transfers at a hub (a transfer is a layover between flights), is
  never suppressed by the scan's flown keys, and counts as ground travel for
  `pGround` and `pImportedFirst`. People in transit by train stay in the
  conservation identity.
- **Results.** `railRoutes` (how many), `railTrips` (the strongest 120
  between places it likely reached, travellers a day and km), `railSource`,
  `railStats` (places, cells, pairs, routes, travellers and passenger-km a
  day), and `network.railRoutes` in the answer.
- **Rail off.** Turning the train off in the box (`rail: false`) runs the
  model exactly as before, on the same seed.
- **Overlap.** Trips under 300 km overlap with the gravity commuting, which
  covers every mode. Both are kept; excluding the pairs that are already
  linked would drop rail.
- **Limits.** The zoom-8 tiles carry about 84 % of route km. Branch lines are
  missing in places (for example Italy, Czechia, Japan and Saint John), and
  some parallel tracks count twice (China). The finer zoom-10 lines are laid
  over within 100 km of each outbreak location and near landings, for the
  reach on the map only.

## Random seed and substreams

The Random seed box fixes the result: the same seed with the same inputs gives
the same answer. Blank picks a seed from the inputs (the window, the places,
the airports, the profile and the scan's flights, never the number of runs).
Each run `r` of the ensemble draws from its own stream, seeded
`(seed + r × RUN_STRIDE) >>> 0` with `RUN_STRIDE = 0x9E3779B9`, so run 0 uses
the seed itself, run `r` does not depend on how many runs were asked for, and
50 runs are a prefix of 200 at the same seed. This made every multi-run seeded
result differ once from earlier builds.

With Compare against set, run `r` of the comparison arm uses the same
substream as run `r` of the main arm: that is the common-random-number
pairing. The derived seed ignores `compare`, so turning the comparison on
keeps the main arm's seed. Its result then has fewer runs, a prefix of the
full-budget ensemble, because arm A gets half the budget.

## Sources

- Balcan et al. 2009, PNAS: GLEAM metapopulation model, air travel and commuting.
- Zipf 1946, American Sociological Review: the P1P2/D rail travel model.
- World Bank WDI IS.RRS.PASG.KM (CC BY 4.0): rail passenger-km by country.
- OpenStreetMap contributors (ODbL), through OpenMapTiles and OpenFreeMap: the
  world rail network.
- Greengard & Rokhlin 1987, J Comput Phys: well-separated cells, used here to
  count every pair of rail places once.
- Ferguson et al. 2020, Imperial College Report 9: hospital and intensive-care
  pathway, household contact share, non-pharmaceutical interventions.
- Davies et al. 2020, Lancet Public Health: age-specific severity and NPIs.
- Gomes et al. 2022, J Theor Biol: heterogeneous susceptibility and the herd
  immunity threshold.
- Kissler et al. 2020, Science: waning immunity and SIRS dynamics.
- Bubar et al. 2021, Science: vaccination coverage, efficacy and priority.
- Lipsitch & Dean 2020, Science: vaccine effects on transmission and severity.
- Flaxman et al. 2020, Nature: intervention effects on transmission.
- Petherick et al. 2021, Nature Human Behaviour: compliance fatigue.
- Weitz et al. 2020, PNAS: awareness-driven behaviour and its fatigue.
- Funk et al. 2009, PNAS: the spread of awareness.
- Chinazzi et al. 2020, Science: travel restrictions and imported cases.
- Russell et al. 2021, Lancet Public Health: imported versus local cases.
- Gostic et al. 2015, eLife: traveller screening.
- Poletto et al. 2012, Sci Rep: hub transfers and layovers.
- Grassly et al. 2020, Lancet Infect Dis: testing capacity.
- Davies et al. 2021, Science and Campbell et al. 2021, Euro Surveill: variant
  takeover.
- Wilson 1927, JASA: the score interval.
- Lloyd-Smith et al. 2005, Nature: superspreading and extinction probability.
- Saltelli et al. 2008, Global Sensitivity Analysis: one-at-a-time sensitivity.
- Gog & Grenfell 2002, PNAS: status-based immunity between strains.
- Kerr et al. 2021, PLoS Comput Biol (Covasim): several strains with
  cross-immunity.
- Glasserman 2003, Monte Carlo Methods in Financial Engineering: common random
  numbers.
- Kleijnen 2015, Design and Analysis of Simulation Experiments: paired
  simulation comparisons.
- Cori et al. 2013, Am J Epidemiol: Rt by the renewal equation.
- Gostic et al. 2020, PLoS Comput Biol: practical Rt estimation.
- Wallinga & Lipsitch 2007, Proc R Soc B: generation intervals and
  reproduction numbers.
