# Quebec French (`fr-CA`)

Catalog: `src/i18n/locales/fr-CA.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

The language picker names it **Français Québécois**. It is the only French
shipped, so a browser set to any French (`fr`, `fr-FR`) opens in it, and
`?lang=fr-CA` selects it. Dates and numbers follow Canadian French through
`Intl` (`1 234,5`, `2026-10-17`).

## Style

- Quebec usage, as the Office québécois de la langue française recommends:
  courriel, téléverser, en ligne, infonuagique (cloud), cellulaire,
  traversier (ferry), autobus, stationnement, fin de semaine, nouvelles (news).
- Address the user with "vous" imperatives: « Cliquez », « Choisissez »,
  « Réessayez ». Tooltips that name an action use the infinitive:
  « Développer le panneau », « Réinitialiser la caméra ».
- Sentence case, not Title Case: "Live Flights" → « Vols en direct ».
  UPPERCASE English stays UPPERCASE, and capitals keep their accents:
  « EN DIRECT », « DÉLAI DÉPASSÉ », « ÉTAT ».
- Spacing: a non-breaking space before `:` and `%` and inside « », and none
  before `;`, `?` and `!` (Quebec practice): « Clé inconnue : {name} »,
  « 20 % de nuages », « Retirer cette clé? ». Thousands are grouped with a
  non-breaking space: « 1 000 km ».
- Short labels, chips and HUD readouts stay short; a standard abbreviation
  with a period beats a wrapped line: PRÉC., SUIV., SUPPR., DIR., VIT. VERT.
- The HUD codes HDG, BRG, CRS, FOV, DEST, SPD, RANGE, ALT, GS and TRK stay in
  English everywhere, as in cockpit avionics; a word in a sentence is
  translated: heading → « cap », range → « portée ».
- Keyboard keys stay in English: Space, Esc, Enter, Tab, Shift, Backspace,
  H, 1–9 (« Maintenez Space pour parler »).
- Units: km, m, km/h, m/s, nd (knots), pi (feet), mi/h, h, min, s, j (days);
  in UPPERCASE text KM, ND, PI. Money: « 15 k$ », « 2 M$ », « 1 G$ »
  (milliard). MiB is Mio. `°` stays.
- "ago" goes before the time: « il y a {count} min ». When a placeholder
  already holds a localized "ago" text (`{age}`, `{ago}`), do not add
  « il y a » again.

## Plurals

A `tn()` entry needs three forms. `Intl.PluralRules('fr-CA')` picks:

| Form    | Counts                                 | Example              |
| ------- | -------------------------------------- | -------------------- |
| `one`   | 0 and 1 (also 1,5)                     | 0 caméra, 1 caméra   |
| `many`  | 1 000 000, 2 000 000… (exact millions) | 1 000 000 de caméras |
| `other` | everything else: 2–999 999…            | 3 caméras            |

French takes the singular for 0. The `many` form is the `other` text with
« de » after the number, « d' » before a vowel: « {count} de caméras
chargées », « {count} d'aéronefs captés ».

## Glossary

| English                                     | Français québécois                                       |
| ------------------------------------------- | -------------------------------------------------------- |
| layer / data layer                          | couche / couche de données                               |
| feed / source / data source                 | flux / source / source de données                        |
| LIVE (status) / live data                   | EN DIRECT / données en direct                            |
| SIMULATED                                   | SIMULÉ                                                   |
| stale / degraded / unavailable              | périmé / dégradé / non disponible                        |
| retry / retrying                            | nouvel essai / nouvel essai en cours                     |
| key (API key) / token                       | clé (clé d'API) / jeton                                  |
| POWER UP / POWERED UP                       | ALLUMAGE / ALLUMÉ (to light a source: allumer)           |
| Provider Settings                           | Paramètres des fournisseurs                              |
| ON / OFF (state chips)                      | ACTIF / INACTIF                                          |
| enable / disable                            | activer / désactiver                                     |
| remove / delete                             | retirer / supprimer                                      |
| globe / map / map source / map stack        | globe / carte / source de la carte / ensemble de cartes  |
| basemap / tile                              | fond de carte / tuile                                    |
| aircraft, plane / flight / military flights | aéronef, avion / vol / vols militaires                   |
| vessel, ship                                | navire                                                   |
| satellite / shell (Starlink) / DENSE        | satellite / couche / DENSE                               |
| launch / launch site / space mission        | lancement / site de lancement / mission spatiale         |
| docked (spacecraft)                         | arrimé                                                   |
| contact / tracking                          | contact / suivi                                          |
| installation / site                         | installation / site                                      |
| mapped / observed                           | cartographié / observé                                   |
| camera / CCTV camera                        | caméra / caméra CCTV                                     |
| earthquake / active fire / contained        | séisme / feu actif / maîtrisé                            |
| radio station / tune                        | station de radio / syntoniser                            |
| road / flow (traffic) / traffic             | route / circulation / circulation                        |
| transit / bus / ferry / bike share          | transport en commun / autobus / traversier / vélopartage |
| roundabout                                  | carrefour giratoire                                      |
| scene / shot / scene recipe / bundle        | scène / plan / recette de scène / archive                |
| briefing / panel / dock                     | briefing / panneau / dock                                |
| cockpit                                     | poste de pilotage (short labels: COCKPIT)                |
| preset / visual preset                      | préréglage / préréglage visuel                           |
| Scope (circular viewport mask) / keyhole    | lunette / trou de serrure                                |
| feather / fade                              | adoucissement / fondu                                    |
| pin (Draw tool) / box (Recent Imagery)      | repère / cadre                                           |
| card (UI)                                   | fiche (never « carte », which is the map)                |
| upload / download                           | téléverser / télécharger                                 |
| cloud (voice)                               | infonuagique                                             |
| air quality / AQHI                          | qualité de l'air / CAS (cote air santé)                  |
| advisory (NHC/CPHC cyclone)                 | avis                                                     |
| Street Level (layer)                        | Niveau de la rue                                         |
| Street View (Google)                        | Street View                                              |
| ISS                                         | SSI                                                      |
| NOT AN ALL-CLEAR                            | PAS UNE FIN D'ALERTE                                     |
| PREV / NEXT                                 | PRÉC. / SUIV.                                            |
| Previous / Next (button text)               | Précédent / Suivant                                      |
| L / R (relative bearing) / compass W        | G / D / O (ouest)                                        |
| SIG / NEWS / LOCAL (briefing tabs)          | SIG / NOUVELLES / LOCAL                                  |
| PITCH / HGT (CCTV calibration chips)        | INCL. / HAUT.                                            |
| click / click to …                          | cliquez / cliquez pour …                                 |

Kept as in English, on purpose (listed under `fr-CA` in
`src/i18n/same-as-english.json`): the HUD codes, units, product and place
names, music genres used as is in French (Blues, Jazz, Rock…), and words
spelled the same in French (MISSION, STATION, SOURCE, Radio, Pause, Style).

## The fork's own tabs

Quebec French is listed in `src/i18n/fork-locales.json`, so it also
translates God's Eye View Canada's five tabs on the left, what they draw on
the globe and the POWER UP chip's count; Spanish and Russian show them in
English ([I18N.md](../I18N.md), "The fork's own tabs"). Their glossary:

| English                                       | Français québécois                           |
| --------------------------------------------- | -------------------------------------------- |
| AI RISK & TRUTH ASSESSMENT (tab)              | RISQUE ET VÉRITÉ PAR IA                      |
| ULTRA SECURITY PACKAGE / package              | TROUSSE DE SÉCURITÉ ULTRA / trousse          |
| SOCIAL MEDIA ANALYSIS                         | ANALYSE DES MÉDIAS SOCIAUX                   |
| OUTBREAK LOCATIONS & PREDICTED SPREAD         | LIEUX D'ÉCLOSION ET PROPAGATION PRÉVUE       |
| ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM    | SIMULATION D'ENTRAÎNEMENT DU MONDE PAR IA    |
| outbreak / spread / commuting                 | éclosion / propagation / navettage           |
| SCAN TRAVEL / HOW CONTAGIOUS                  | ANALYSER LES DÉPLACEMENTS / CONTAGIOSITÉ     |
| superspreading / case fatality / lockdown     | supercontamination / létalité / confinement  |
| SEND HELP / STAND DOWN                        | ENVOYER DE L'AIDE / FIN D'ALERTE             |
| helper / token / token holder                 | aidant / jeton / détenteur du jeton          |
| Ultra cell                                    | cellulaire Ultra                             |
| home list (UPDATE MY LIST)                    | ma liste (METTRE À JOUR MA LISTE)            |
| skill / CONFIRMED / NO CONFIRMATION           | compétence / CONFIRMÉ / AUCUNE CONFIRMATION  |
| CLAIM REJECTED                                | DÉCLARATION REJETÉE                          |
| bot / swarm / Chief of Staff                  | robot / essaim / chef de cabinet             |
| check-ins (social platforms)                  | enregistrements                              |
| world model / train / post-train              | modèle du monde / entraîner / post-entraîner |
| binned day / BINNING                          | jour agrégé / AGRÉGATION                     |
| epoch / loss / held-out                       | époque / perte / hors échantillon            |
| checkpoint / adapter / INFER                  | point de contrôle / adaptateur / INFÉRER     |
| FINANCIAL ASSETS / PRICE MOVES                | ACTIFS FINANCIERS / VARIATIONS DE PRIX       |
| SIM SCENARIOS                                 | SCÉNARIOS DE SIMULATION                      |
| licence classes OPEN, NC, RESTRICTED, UNCLEAR | LIBRE, NC, RESTREINT, INCERTAIN              |
| PERSONAL, STATIC                              | PERSONNEL, STATIQUE                          |

The licence notes on the AI World rows are translated; licence names
(CC BY 4.0, ODbL 1.0), provider and dataset names, and a citation the
provider asks for ("CelesTrak, Dr. T.S. Kelso") stay as written. Card and
product names on POWER UP's cards stay in English: GROK BOT, OPENAI DOTS,
SMS RELAY.

## Not translated yet

These stay English in every language for now (`data-i18n-skip`,
`src/i18n/fork-english-only.json`): SEA SURFACE TEMPERATURE (SST); POWER
UP's device, home and business camera and road CCTV key sections; the home
and business sites and shortcut pills in the LOCATION row; the CCTV panel's
picture and the LOCATION tray resize handles; the CCTV area messages. Text
the server writes is shown as it comes: model answers, a forecast's reasons
and server error details.
