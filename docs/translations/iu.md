# Inuktitut (`iu`)

Catalog: `src/i18n/locales/iu.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

The language picker names it **Inuktitut**, and `?lang=iu` selects it. A
browser set to any Inuktitut tag (`iu`, `iu-Cans-CA`) opens in it. The text is
Eastern Canadian (Nunavut) Inuktitut written in syllabics: ᐃᓄᒃᑎᑐᑦ.

## A first draft: it needs a fluent speaker's review

The catalog was drafted for this project, not written by a fluent speaker.
Every word was checked against the Nunavut Hansard English–Inuktitut parallel
corpus (Legislative Assembly of Nunavut, 1.3 million sentence pairs, version
3.0.1 as distributed by OPUS): where a word's start never occurs in Hansard it
was replaced by the Hansard form, and interface terms were compared with
MediaWiki's Inuktitut (`ike-cans`) interface messages. Words Hansard does not
use for these ideas are built from common roots (ᐃᑭᐊᖅ for a map layer,
ᐃᓯᖅᑎᑦᓯᔾᔪᑎ for a token). Corrections from Inuktitut speakers are welcome:
edit the catalog and run `npm run i18n` ("Fixing a translation" in
TRANSLATORS.md), and record a settled term below.

## Script and spelling

- Syllabics as the Government of Nunavut and Hansard write them: finals
  (ᖅ ᒃ ᑦ ᓐ ᓪ), long vowels with the dot (ᐋ ᐄ ᐆ) and the precomposed
  ᙱ ᙵ ᙳ for _nng_: ᐊᑐᐃᓐᓇᐅᙱᑦᑐᖅ, ᓄᓇᙳᐊᖅ.
- The UI fonts have no syllabics, so `html[lang='iu']` in
  `src/ui/styles/foundation.css` names the system fonts that carry them:
  Pigiarniq (Government of Nunavut), Euphemia UCAS (Apple), Euphemia and
  Gadugi (Windows) and Noto Sans Canadian Aboriginal (Android).
- A suffix on a Latin name or a placeholder follows a hyphen: `{place}-ᒧᑦ`
  (to {place}), `GitHub-ᒧᑦ`, `{count}-ᓂᑦ {index}` ({index} of {count}).
- Buttons and commands use the imperative in _-lugu / -lugit_ (ᐲᕐᓗᒍ remove
  it, ᑕᑯᒃᓴᐅᑎᓪᓗᒋᑦ show them); states use _-juq / -tuq_ (ᐊᑐᐃᓐᓇᐅᔪᖅ
  available, ᓄᖅᑲᖅᓯᒪᔪᖅ stopped).

## Plurals

A `tn()` or `tln()` entry needs three forms. `Intl.PluralRules('iu')` picks:

| Form    | Counts                    | Example    |
| ------- | ------------------------- | ---------- |
| `one`   | 1                         | 1 ᐊᔾᔨᓕᐅᕈᑎ  |
| `two`   | 2                         | 2 ᐊᔾᔨᓕᐅᕈᑏᒃ |
| `other` | 0, 3 and up, and decimals | 3 ᐊᔾᔨᓕᐅᕈᑏᑦ |

The dual ends in _-k_ (ᐊᔾᔨᓕᐅᕈᑏᒃ, ᐃᓃᒃ; verbs ᑐᖅᑯᖅᑕᐅᓯᒪᔫᒃ), the plural in
_-t_ (ᐊᔾᔨᓕᐅᕈᑏᑦ, ᐃᓃᑦ; verbs ᑐᖅᑯᖅᑕᐅᓯᒪᔪᑦ). A loan word that does not
inflect keeps one form in all three (ᐸᔅ, bus).

## Numbers, dates and units

`Intl` has Inuktitut's plural rules but no Inuktitut number, date or
relative-time data, so `src/i18n/index.js` formats those in Canadian English,
the way Nunavut writes numbers: `1,234.5`, `January 15, 2026`, "5 minutes
ago". Month names and relative times from `Intl` therefore stay in English.
Units stay in Latin letters: km, m, km/h, kts, ft, MB, GB, °, %.

## Style

- Keep short labels, chips and buttons short; a tooltip can be a sentence.
- The HUD codes (HDG, BRG, CRS, FOV, DEST, KTS, FT, FLT, MIL, WX, SIG, NET)
  stay in Latin letters, as in avionics.
- Product, provider, platform and dataset names stay as written (Google Maps,
  OpenSky, GROK BOT, OPENAI DOTS, SMS RELAY), and so do keyboard keys (Space,
  Esc, Enter, Shift).
- Places with a syllabic name in Hansard use it: ᐋᑐᕚ (Ottawa), ᑐᕌᓐᑐ
  (Toronto), ᓯᑳᒍ (Chicago), ᓂᐅ ᔪᐊᒃ (New York), ᒥᒃᓯᑯ (Mexico), ᔪᐊᕈᑉ
  (Europe), ᐊᒥᐊᓕᑲ (United States), ᑲᓇᑕ (Canada). Other places stay in Latin
  letters (Frankfurt, Mumbai, Zurich, Singapore, Beijing).
- The page the phone link opens is served in English, so where a message
  points at that page's buttons, SEND HELP and STAND DOWN stay in English.
  The same buttons in the ULTRA tab are translated (see below).
- A message that names a button uses that button's own Inuktitut label, so
  the two always match; the fixed labels are in the glossaries.

## Glossary

| English                                  | Inuktitut                                   |
| ---------------------------------------- | ------------------------------------------- |
| layer / data layer                       | ᐃᑭᐊᖅ / ᑐᓴᐅᒪᔾᔪᑏᑦ ᐃᑭᐊᖏᑦ                       |
| data / information                       | ᑐᓴᐅᒪᔾᔪᑏᑦ / ᑐᑭᓯᒋᐊᕈᑏᑦ                         |
| source / provider                        | ᓴᖅᑭᕝᕕᒃ / ᐱᔨᑦᑎᖅᑎ                             |
| map / globe                              | ᓄᓇᙳᐊᖅ / ᓄᓇᕐᔪᐊᙳᐊᖅ                            |
| camera / photo / video                   | ᐊᔾᔨᓕᐅᕈᑎ / ᐊᔾᔨᙳᐊᖅ / ᑕᕐᕆᔭᓕᐊᖅ                  |
| aircraft / flight / airport              | ᖃᖓᑕᓲᖅ / ᖃᖓᑕᓂᖅ / ᒥᑦᑕᕐᕕᒃ                      |
| ship, vessel / boat                      | ᐅᒥᐊᕐᔪᐊᖅ / ᐅᒥᐊᖅ                              |
| satellite / launch                       | ᖁᒻᒧᐊᑦᑎᑕᐅᓯᒪᔪᖅ / ᖁᒻᒧᐊᒃᑎᑕᐅᓂᖅ                   |
| military                                 | ᐅᓇᑕᖅᑐᒃᓴᐃᑦ                                   |
| weather / forecast                       | ᓯᓚ / ᓯᓚᓐᓂᐊᕐᓂᖅ                               |
| key (API key) / token / password         | ᐅᒃᑯᐃᔾᔪᑎ / ᐃᓯᖅᑎᑦᓯᔾᔪᑎ / ᐃᔨᖅᓯᒪᔪᖅ ᐅᖃᐅᓯᖅ         |
| POWER UP                                 | ᐃᑯᐊᓪᓚᖅᑎᑦᓯᓂᖅ                                 |
| ON / OFF                                 | ᐃᑯᐊᓪᓚᓯᒪᔪᖅ / ᖃᒥᓯᒪᔪᖅ                          |
| save / remove, delete                    | ᑐᖅᑯᕐᓗᒍ / ᐲᕐᓗᒍ                               |
| open / close / search                    | ᒪᑐᐃᕐᓗᒍ / ᒪᑐᓗᒍ / ᕿᓂᕐᓗᒍ                       |
| live / now                               | ᒫᓐᓇᐅᔪᖅ / ᒫᓐᓇ                                |
| unavailable / error / failed             | ᐊᑐᐃᓐᓇᐅᙱᑦᑐᖅ / ᑕᒻᒪᖅᓯᒪᔪᖅ / ᐊᔪᖅᓴᖅᑐᖅ             |
| cockpit                                  | ᐊᐅᓚᑦᑎᕕᒃ                                     |
| contact (a tracked object) / context     | ᓇᐅᑦᑎᖅᓱᖅᑕᐅᔪᖅ / ᐊᕙᑎᖓ                          |
| panel / tab                              | ᒪᑉᐱᑕᖅ                                       |
| preset                                   | ᐋᖅᑭᒃᓯᒪᔪᖅ                                    |
| radio / station / receiver               | ᓈᓚᐅᑦ / ᑐᓴᖅᑎᑦᓯᕕᒃ / ᑐᓴᐅᑎ                      |
| filter                                   | ᓴᓗᒻᒪᖅᓴᐃᔾᔪᑎ                                  |
| colour: cyan, yellow, orange, red, green | ᐊᒥᐊᖓ: ᑐᖑᔪᖅ, ᖁᖅᓱᖅᑐᖅ, ᐊᐅᐸᔮᖅᑐᖅ, ᐊᐅᐸᖅᑐᖅ, ᐱᕈᖅᑐᑐᑦ |
| dev server                               | dev ᖃᕋᓴᐅᔭᕐᔪᐊᖅ                               |

## The fork's own tabs

Inuktitut is listed in `src/i18n/fork-locales.json`, so it also translates
God's Eye View Canada's five tabs on the left, what they draw on the globe and
the POWER UP chip's count ([I18N.md](../I18N.md), "The fork's own tabs"). Their
glossary:

| English                                     | Inuktitut                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| AI RISK & TRUTH ASSESSMENT (tab)            | AI ᐊᑦᑕᓇᕐᓂᖓᓄᑦ ᓱᓕᓂᖓᓄᓪᓗ ᖃᐅᔨᓴᕐᓂᖅ                                           |
| ULTRA SECURITY PACKAGE / package            | ULTRA ᐊᑦᑕᓇᖅᑕᐃᓕᒪᓂᕐᒧᑦ ᑲᑎᖅᓱᖅᑕᐅᓯᒪᔪᑦ / ᑲᑎᖅᓱᖅᑕᐅᓯᒪᔪᑦ                          |
| SOCIAL MEDIA ANALYSIS                       | ᑐᓴᖃᑎᒌᒍᑏᑦ ᖃᐅᔨᓴᕐᓂᖏᑦ                                                      |
| OUTBREAK LOCATIONS & PREDICTED SPREAD       | ᐊᐃᑦᑐᐃᓇᖅᑐᖅ ᐋᓐᓂᐊᖅ ᐃᓂᖏᑦ & ᓇᓚᐅᑦᓵᖅᑕᐅᓯᒪᔪᖅ ᓯᐊᒻᒪᒃᐸᓪᓕᐊᓂᖓ                        |
| ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM  | ᖃᕋᓴᐅᔭᒃᑯᑦ ᐃᓱᒪᓕᐅᕐᓂᖅ ᓯᓚᕐᔪᐊᕐᒧᑦ ᐃᓕᓐᓂᐊᖅᑎᑦᓯᓂᕐᒧᑦ ᐱᙳᐊᕐᓂᖅ                        |
| outbreak / spread / commuting               | ᐊᐃᑦᑐᐃᓇᖅᑐᖅ ᐋᓐᓂᐊᖅ / ᓯᐊᒻᒪᒃᐸᓪᓕᐊᓂᖅ / ᐱᓕᕆᐊᕐᓂᕐᒧᑦ ᐃᖏᕐᕋᓂᖅ                       |
| SCAN TRAVEL / HOW CONTAGIOUS                | ᐃᖏᕐᕋᓂᖅ ᕿᓂᕐᓗᒍ / ᖃᓄᖅ ᐊᐃᑦᑐᐃᓇᖅᑎᒋᒻᒪᖔᑦ                                       |
| RUN EPIDEMIC MODEL / MAP FUTURE SPREAD      | ᐋᓐᓂᐊᖅ ᓯᐊᒻᒪᒃᐸᓪᓕᐊᓂᕐᒧᑦ ᐆᑦᑑᑎ ᐊᐅᓚᑦᑎᓗᒍ / ᓯᕗᓂᒃᓴᒥ ᓯᐊᒻᒪᒃᐸᓪᓕᐊᓂᖓ ᓄᓇᙳᐊᕐᒥ ᑕᑯᒃᓴᐅᑎᓪᓗᒍ |
| lockdown / quarantine / vaccination         | ᐊᖏᕐᕋᒦᖁᔨᓂᖅ / ᐃᒻᒥᒃᑰᖓᓂᖅ / ᑲᐱᔭᐅᓂᖅ                                          |
| SEND HELP / STAND DOWN / EXTEND HELP        | ᐃᑲᔪᖅᑕᐅᔪᒪᔪᖓ / ᐃᑲᔪᖅᑕᐅᔪᒪᓐᓃᖅᑐᖓ / ᐃᑲᔪᖅᑕᐅᔪᒪᓂᖅ ᑕᑭᒡᓕᒋᐊᖅᑎᓪᓗᒍ                    |
| token / token holder / helper               | ᐃᓯᖅᑎᑦᓯᔾᔪᑎ / ᑎᒍᒥᐊᖅᑎ / ᐃᑲᔪᖅᑎ                                             |
| SHARE ENCRYPTED ULTRA TOKENS / RESET TOKENS | ᐃᔨᖅᓯᒪᔪᑦ ULTRA ᐃᓯᖅᑎᑦᓯᔾᔪᑏᑦ ᐊᒥᖅᑳᕐᓗᒋᑦ / ᐃᓯᖅᑎᑦᓯᔾᔪᑏᑦ ᐅᑎᖅᑎᓪᓗᒋᑦ                |
| Ultra cell                                  | Ultra ᐅᖄᓚᐅᑎᕋᓛᖅ                                                         |
| NETWORK / HELP NETWORK                      | ᑲᓱᖅᓯᒪᓂᖅ / ᐃᑲᔪᕐᓂᕐᒧᑦ ᑲᓱᖅᓯᒪᓂᖅ                                             |
| home list / directory                       | ᐊᖏᕐᕋᒥ ᑎᑎᕋᖅᓯᒪᔪᑦ / ᐊᑎᓕᐅᖅᑕᐅᓯᒪᔪᑦ                                           |
| skill / CONFIRMED / NO CONFIRMATION         | ᐱᔪᓐᓇᐅᑎ / ᓇᓗᓇᐃᖅᓯᒪᔪᖅ / ᓇᓗᓇᐃᖅᓯᒪᙱᑦᑐᖅ                                       |
| REJECTED CLAIM                              | ᐅᖃᐅᓯᐅᓯᒪᔪᖅ ᐊᖏᖅᑕᐅᙱᑦᑐᖅ                                                    |
| bot / swarm / Chief of Staff                | BOT / BOT ᐃᓚᒌᑦ / ᐃᖅᑲᓇᐃᔭᖅᑏᑦ ᐊᖓᔪᖅᑳᖓ                                      |
| HELP DELIVERY                               | ᐃᑲᔪᕐᓂᖅ ᑐᓂᔭᐅᔪᖅ                                                          |
| world model / train / post-train            | ᓯᓚᕐᔪᐊᕐᒧᑦ ᐆᑦᑑᑎ / ᐃᓕᓐᓂᐊᖅᑎᑦᓯᓂᖅ / ᐃᓕᓐᓂᐊᖅᑎᑦᓯᒃᑲᓐᓂᕐᓂᖅ                         |
| binned / predictions / HORIZON              | ᐊᕕᒃᑕᐅᓯᒪᔪᖅ / ᓯᕗᓂᒃᓴᒥ ᓇᓚᐅᑦᓵᕐᓂᐅᔪᑦ / ᓯᕗᓂᒃᓴᒧᑦ ᐅᖓᓯᓐᓂᖓ                         |
| epoch / loss / held-out                     | ᐊᓂᒍᐃᓂᖅ / ᑕᒻᒪᕐᓂᖓ / ᐆᒃᑐᕋᐅᑎᒃᑯᑦ                                            |
| base model / checkpoint / adapter           | ᑐᙵᕕᒋᔭᐅᔪᖅ ᐆᑦᑑᑎ / ᑐᖅᑯᖅᓯᒪᔪᖓ / ᑲᓱᖅᓯᔾᔪᑎ                                     |
| FINANCIAL ASSETS / PRICE MOVES              | ᑮᓇᐅᔭᓕᕆᓂᕐᒧᑦ ᐱᖁᑏᑦ / ᐊᑭᐅᑉ ᐊᓯᔾᔨᕐᓂᖏᑦ                                        |
| licence classes OPEN, NC, RESTRICTED        | ᒪᑐᐃᖅᓯᒪᔪᖅ, NC, ᑭᓪᓕᖃᖅᑐᖅ                                                  |
| UNCLEAR, PERSONAL, STATIC                   | ᓇᓗᓇᖅᑐᖅ, ᓇᖕᒥᓂᖅ, ᐊᓯᔾᔨᖅᐸᙱᑦᑐᖅ                                              |

The licence notes on the AI World rows are translated; licence names
(CC BY 4.0, ODbL 1.0), provider and dataset names, and a citation the provider
asks for ("CelesTrak, Dr. T.S. Kelso") stay as written.

Kept as in English, on purpose (listed under `iu` in
`src/i18n/same-as-english.json`): the HUD codes, units, product, platform and
phone-model names, places without a syllabic name, disease names (COVID-19,
SARS, MERS, Ebola, Mpox), music genres, stock indexes and currency pairs, and
licence notes that are only names ("Open-Meteo (CC BY 4.0)").

## Not translated yet

These stay English in every language for now (`data-i18n-skip`,
`src/i18n/fork-english-only.json`): SEA SURFACE TEMPERATURE (SST); POWER UP's
device, home and business camera and road CCTV key sections; the home and
business sites and shortcut pills in the LOCATION row; the CCTV panel's
picture and the LOCATION tray resize handles; the CCTV area messages. Text the
server writes is shown as it comes: model answers, a forecast's reasons and
server error details.
