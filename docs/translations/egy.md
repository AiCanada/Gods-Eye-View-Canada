# Ancient Egyptian (`egy`)

Catalog: `src/i18n/locales/egy.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

The language picker names it **Ancient Egyptian**, and `?lang=egy` selects it.
A browser set to an Egyptian tag (`egy`, `egy-Egyp-EG`) opens in it. The text
is written in hieroglyphs: 𓂋𓏤 𓈖 𓆎𓅓𓏏𓊖 (_rʾ n Km.t_, the speech of Egypt).

## A first draft: it needs an Egyptologist's review

The catalog was drafted for this project by machine, not by an Egyptologist.
It prefers the language of the Old Kingdom, the pyramid builders, and takes
words from any later stage where the Old Kingdom has none:

- Every sentence was first written in transliteration, then turned into
  hieroglyphs word by word from attested spellings, in this order: a reviewed
  glossary entry; the word as the Thesaurus Linguae Aegyptiae (TLA) corpus
  writes it, an Old Kingdom spelling (texts dated before about 2100 BCE)
  ahead of any later one; Wikidata's Egyptian lexemes (TLA lemma list); and
  only then a spelling built from the word's signs.
- Sources: TLA Earlier Egyptian sentences v18 and Late Egyptian sentences
  v19 (Berlin-Brandenburg Academy and Saxon Academy, CC BY-SA 4.0), Wikidata
  Egyptian lexemes (CC0), English Wiktionary's Egyptian entries via
  wiktextract/kaikki (CC BY-SA), and Unicode's Unikemet sign data.
- Modern things have no Old Kingdom word. They are named with old words in a
  new sense (an aircraft is a boat of the sky, a bot a shabti, the Chief of
  Staff bot a vizier); the glossary below lists them.

Corrections are welcome: edit the catalog and run `npm run i18n` ("Fixing a
translation" in TRANSLATORS.md), and record a settled term below.

## Script

- Hieroglyphs only, from the Unicode base block (U+13000–U+1342F, which every
  hieroglyph font covers), written left to right in a plain line. The
  quadrat format controls (U+13430–U+1345F) are not used: few fonts draw
  them, and stacked groups cannot wrap in a button or a chip.
- Hieratic and Demotic, the cursive hands, have no Unicode encoding, so the
  page cannot show them as text. Coptic, the last stage, is written in its
  own alphabet and is a different language from the Old Kingdom's; it is not
  used.
- Words are separated by spaces so the text can wrap; a suffix pronoun is
  written onto its word (𓉐𓎡 _pr=k_, your house). The negation is 𓂜 (_n_).
- The UI fonts have no hieroglyphs, so `html[lang='egy']` in
  `src/ui/styles/foundation.css` names the fonts that carry them: Noto Sans
  Egyptian Hieroglyphs (`index.html` loads it from Google Fonts, and the
  browser fetches it only when a hieroglyph is drawn; Apple and Android ship
  it too), Segoe UI Historic (Windows), and the free Aegyptus and NewGardiner
  (JSesh) faces.

## Plurals

Egyptian has a singular, a dual and a plural. `Intl` has no plural rules for
`egy`, so `pluralRulesLocale()` in `src/i18n/locale.js` counts it as
Inuktitut: a `tn()` or `tln()` entry needs three forms.

| Form    | Counts                    | Example        |
| ------- | ------------------------- | -------------- |
| `one`   | 1                         | 𓂧𓊪𓏏𓊛 𓈖𓏏 𓊪𓏏𓇯 1  |
| `two`   | 2                         | 𓂧𓊪𓏏𓊛𓊛 𓈖𓏏 𓊪𓏏𓇯 2 |
| `other` | 0, 3 and up, and decimals | 𓂧𓊪𓏏𓊛𓏥 𓈖𓏏 𓊪𓏏𓇯 3 |

The dual writes the word's last sign twice (𓊛𓊛, two boats); the plural adds
the three strokes 𓏥, or takes the plural the corpus writes (𓏝𓏝𓏝, documents).
A number stays after its noun, as in Egyptian.

## Numbers, dates and units

`Intl` has no Egyptian number, date or relative-time data, so
`src/i18n/index.js` formats those in Canadian English, in Western digits:
`1,234.5`, `January 15, 2026`, "5 minutes ago". The hieroglyphic numerals
(𓏺 𓎆 𓍢 …) are not used; month names and relative times from `Intl` stay in
English. Units stay in Latin letters: km, m, km/h, kts, ft, min, MB, GB, °, %.

## Style

- Keep short labels, chips and buttons short; a tooltip can be a sentence.
- Buttons and commands use the bare verb (𓋴𓏠𓈖 _smn_, save); a finished
  action the passive (𓋴𓏠𓈖𓈖𓏏𓅱 _smn.n.tw_, saved); "loading" is 𓁷𓂋 𓏎𓈖𓏏
  (_ḥr ꞽni̯.t_, bringing), "unavailable" 𓂜 𓃹𓈖 (_n wn_, there is not).
- The HUD codes (HDG, BRG, CRS, FOV, KTS, FT) stay in Latin letters, as in
  avionics, and so do product, provider, platform, dataset and phone-model
  names (Google Maps, OpenSky, GROK BOT, OPENAI DOTS, SMS RELAY), keyboard
  keys (Space, Esc, Enter), places, disease names, music genres, stock
  indexes and currency pairs.
- The page the phone link opens is served in English, so where a message
  points at that page's buttons, SEND HELP and STAND DOWN stay in English.
  The same buttons in the ULTRA tab are translated (see below).
- A message that names a button uses that button's own Egyptian label, so the
  two always match.

## Hover help

A mouse that rests two seconds on hieroglyphs shows the English they were
translated from, in a small box above the pointer (`src/ui/englishHint.js`).
The page keeps the English of each line it draws, values filled in, so a line
with a number or a name reads back exactly; a line put together from several
translated pieces is read back piece by piece from the catalog
(`src/i18n/backToEnglish.js`). Where Egyptian uses one word for two English
labels (_ḥtp_ is both "Pause" and "Paused"), the help shows one of them. Mouse
only: touch has no hover, so the phone page is unchanged.

## Glossary

| English                              | Hieroglyphs                    | Transliteration                         | Literally                              |
| ------------------------------------ | ------------------------------ | --------------------------------------- | -------------------------------------- |
| map, globe                           | 𓇾𓈇𓏤                            | _tꜣ_                                    | land, earth                            |
| map layer                            | 𓎛𓃀𓋴𓋳                           | _ḥbs_                                   | a covering                             |
| data                                 | 𓇋𓊪𓅱𓏛                           | _ꞽp.w_                                  | counts, reckonings                     |
| source                               | 𓎸𓅓𓏏𓈗                           | _ẖnm.t_                                 | well, spring                           |
| camera                               | 𓁹𓏏𓏤                            | _ꞽr.t_                                  | eye                                    |
| photo, image                         | 𓏏𓏏𓅱                            | _twt_                                   | image, statue                          |
| video                                | 𓏏𓏏𓅱 𓋹𓈖𓐍                        | _twt ꜥnḫ_                               | living image (as in Tutankhamun)       |
| aircraft, flight                     | 𓂧𓊪𓏏𓊛 𓈖𓏏 𓊪𓏏𓇯                    | _dp.t n.t p.t_                          | boat of the sky                        |
| airport                              | 𓌻𓂋𓇋𓇋𓏏𓈇 𓈖𓏏 𓂧𓊪𓏏𓊛𓏥 𓈖𓏏 𓊪𓏏𓇯         | _mr.yt n.t dp.wt n.t p.t_               | harbour of the sky boats               |
| ship, vessel                         | 𓊢𓂝𓅱𓊛                           | _ꜥḥꜥ_                                   | ship                                   |
| train                                | 𓅨𓂋𓂋𓇋𓇋𓏏𓌝 𓈖𓏏 𓃀𓇋𓄿𓄑𓈖𓇯𓈒𓏥            | _wrry.t n.t bꞽꜣ-n-p.t_                  | wagon of iron                          |
| rail lines                           | 𓍯𓏏𓈐𓏥 𓈖𓏏 𓃀𓇋𓄿𓄑𓈖𓇯𓈒𓏥               | _wꜣ.wt n.t bꞽꜣ-n-p.t_                   | roads of iron                          |
| traffic                              | 𓈙𓅓𓂻𓇋𓇋𓂻                         | _šm-ꞽi̯_                                 | going and coming                       |
| weather                              | 𓋴𓐍𓂋𓏲𓏛𓏥 𓊪𓏏𓇯                     | _sḫr.w p.t_                             | conditions of the sky                  |
| forecast, predict                    | 𓋴𓂋𓃱                            | _sr_                                    | to foretell                            |
| earthquake                           | 𓏌𓅨𓂋 𓇾𓈇𓏤                        | _nwr tꜣ_                                | trembling of the earth                 |
| outbreak, epidemic                   | 𓇋𓄿𓂧𓏏𓅪                          | _ꞽꜣd.t_                                 | pestilence                             |
| key (API key)                        | 𓐍𓏏𓅓𓋩                           | _ḫtm_                                   | seal                                   |
| token                                | 𓎗𓅱                             | _wḏ_                                    | decree                                 |
| password                             | 𓂋𓈖𓈙𓏏𓄿𓏛                         | _rn-štꜣ_                                | secret name                            |
| login, account                       | 𓅧                              | _ꜥq_                                    | entry                                  |
| POWER UP                             | 𓂋𓏙𓏏 𓋴𓌂𓐍𓅓                       | _rḏi̯.t sḫm_                             | giving power                           |
| computer, PC                         | 𓎛𓋴𓃀𓐎𓅱𓏛                         | _ḥsb.w_                                 | reckoner                               |
| server                               | 𓉐𓎛𓋴𓃀𓐎                          | _pr-ḥsb_                                | house of reckoning (as pr-ꜥnḫ)         |
| app, platform                        | 𓍍𓏏𓈟                            | _ḥmw.t_                                 | a crafted work                         |
| page, tab                            | 𓏞𓏝                             | _zẖꜣ.w_                                 | a writing                              |
| panel                                | 𓏠𓈖𓉔𓆓𓏞                          | _mnhḏ_                                  | scribe's palette                       |
| network                              | 𓇋𓄿𓂧𓏏𓍱                          | _ꞽꜣd.t_                                 | net                                    |
| browser                              | 𓁹𓏏𓏤 𓈖𓏏 𓇋𓄿𓂧𓏏𓍱                   | _ꞽr.t n.t ꞽꜣd.t_                        | eye of the net                         |
| phone, cell                          | 𓄔𓅓𓂝𓈙𓀁                          | _sḏm-ꜥš_                                | hearer of the call (a servant's title) |
| AI                                   | 𓅜𓐍                             | _ꜣḫ_                                    | akh, an effective spirit               |
| AI model                             | 𓆣𓅱                             | _ḫpr.w_                                 | form, manifestation                    |
| language model                       | 𓆣𓅱 𓈖 𓄓                         | _ḫpr.w n ns_                            | form of the tongue                     |
| train (a model)                      | 𓇼𓄿𓀜                            | _sbꜣ_                                   | to teach                               |
| on / off                             | 𓂋𓌘𓋴 / 𓋴𓇦𓂋                      | _rs / sḏr_                              | awake / asleep                         |
| save / remove / delete               | 𓋴𓏠𓈖 / 𓋴𓎛𓁷𓂋 / 𓋴𓎡𓎝               | _smn / sḥri̯ / sk_                       | make firm / make far / wipe out        |
| open / close / search                | 𓃹𓈖 / 𓐍𓏏𓋩 / 𓎛𓎛𓏭𓂻                | _wn / ḫtm / ḥꞽḥꞽ_                       |                                        |
| clear                                | 𓅱𓂝𓃂                            | _wꜥb_                                   | to purify                              |
| click, press                         | 𓂧𓏇                             | _dmꞽ_                                   | to touch                               |
| red, dark red, orange, yellow, green | 𓅟, 𓅟 𓋴𓈖𓎡𓅱, 𓅟 𓈎𓈖𓇋𓏏𓈓, 𓈎𓈖𓇋𓏏𓈓, 𓍯𓆓𓇅 | _dšr, dšr snk.w, dšr qnꞽ.t, qnꞽ.t, wꜣḏ_ |                                        |

## The fork's own tabs

Ancient Egyptian is listed in `src/i18n/fork-locales.json`, so it also
translates God's Eye View Canada's five tabs on the left, what they draw on
the globe and the POWER UP chip's count ([I18N.md](../I18N.md), "The fork's
own tabs"). Their glossary:

| English                                    | Hieroglyphs                 | Transliteration                | Literally                                                 |
| ------------------------------------------ | --------------------------- | ------------------------------ | --------------------------------------------------------- |
| AI RISK & TRUTH ASSESSMENT                 | 𓇋𓊪𓏝 𓈖 𓇓𓅱𓏏 𓎛𓈖𓂝 𓌳𓂝𓏏 𓈖 𓅜𓐍      | _ꞽp n sw.t ḥnꜥ mꜣꜥ.t n ꜣḫ_     | reckoning of danger and Maat by the akh                   |
| ULTRA SECURITY PACKAGE                     | 𓉔𓈖𓅱𓊬 𓈖 𓎂 ULTRA              | _hnw n zꜣ ULTRA_               | box of protection                                         |
| SOCIAL MEDIA ANALYSIS                      | 𓇋𓊪𓏝 𓈖 𓌃𓂧𓏏𓀁 𓈖 𓂋𓐍𓅚𓀀𓁐𓏥         | _ꞽp n md.t n rḫy.t_            | reckoning of the speech of the people                     |
| OUTBREAK LOCATIONS & PREDICTED SPREAD      | 𓊨𓊨𓊨𓏏 𓈖 𓇋𓄿𓂧𓏏𓅪 𓎛𓈖𓂝 𓊪𓄲𓂋 𓋴𓂋𓃱𓈖𓏏𓅱 | _s.wt n ꞽꜣd.t ḥnꜥ pẖr sr.n.tw_ | places of the pestilence and the spreading foretold       |
| ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM | 𓏏𓏏𓅱 𓈖 𓇼𓄿𓀜 𓈖 𓇾𓈇𓏤 𓈖 𓅜𓐍        | _twt n sbꜣ n tꜣ n ꜣḫ_          | image of the teaching of the world of the akh             |
| GLOBAL ABUNDANCE MAP                       | 𓇾𓈇𓏤 𓈖 𓃀𓂝𓎛𓈗 𓈖 𓇾𓈇𓏤𓏥           | _tꜣ n bꜥḥ n tꜣ.w_              | map of the abundance of the lands                         |
| abundant / scarce                          | 𓃀𓂝𓎛𓈗 / 𓎼𓄿𓅱𓅪                  | _bꜥḥ / gꜣw_                    | inundation, plenty / lack, want                           |
| indicator / figure                         | 𓋴𓐍𓂋𓏲𓏛 / 𓏏𓈖𓅱𓏛                 | _sḫr / ṯnw_                    | condition / number                                        |
| SEND HELP / STAND DOWN                     | 𓉔𓄿𓃀𓂻 𓅓𓂻𓅓𓐟𓀁 / 𓊵𓏏𓊪            | _hꜣb mꞽ-m-sꜣ / ḥtp_            | send the cry "come help" / be at peace                    |
| EXTEND HELP                                | 𓋴𓋴𓐍𓎺 𓅓𓂻𓅓𓐟𓀁                  | _swsḫ mꞽ-m-sꜣ_                 | widen the help                                            |
| token holder / helper                      | 𓇋𓂋𓏭 𓎗𓅱 / 𓏶𓊨𓏏𓂝𓏤              | _ꞽr.ꞽ wḏ / ꞽm.ꞽ-s.t-ꜥ_         | keeper of the decree / one at hand (an Old Kingdom title) |
| bot / swarm                                | 𓆷𓍯𓃀𓏏𓏭𓀾 / 𓆈𓄿𓏏𓀀𓁐𓏥             | _šꜣb.tꞽ / ꜥšꜣ.wt_              | shabti, the figure that answers when called / multitude   |
| Chief of Staff (the Grok Bot)              | 𓅷𓏏𓏤                         | _ṯꜣ.tꞽ_                        | vizier                                                    |
| skill / gift                               | 𓈙𓋴𓐟𓄿𓅱𓄃𓏛 / 𓎛𓈖𓎡𓏏𓂠             | _šsꜣ.w / ḥnk.t_                | wisdom / offering                                         |
| encrypt / encrypted                        | 𓋴𓈙𓏏𓄿𓍔 / 𓈙𓏏𓍔𓄿                | _sštꜣ / štꜣ_                   | make secret / secret                                      |
| home list / directory                      | 𓂋𓐍𓏏𓏛𓏥 𓈖 𓉐 / 𓂋𓐍𓏏𓏛𓏥           | _rḫ.t n pr / rḫ.t_             | list of the house / list                                  |
| alias, AKA                                 | 𓂋𓈖𓅪                         | _rn-nḏs_                       | little name                                               |
| world model / epidemic model               | 𓆣𓅱 𓈖 𓇾𓈇𓏤 / 𓎛𓋴𓃀𓏏𓐎 𓈖 𓇋𓄿𓂧𓏏𓅪    | _ḫpr.w n tꜣ / ḥsb.t n ꞽꜣd.t_   | form of the land / reckoning of the pestilence            |
| HORIZON                                    | 𓅜𓐍𓏏𓇿                        | _ꜣḫ.t_                         | akhet, the horizon                                        |
| FINANCIAL ASSETS / PRICE MOVES             | 𓐍𓏏𓏛𓏥 𓈖 𓇋𓋴𓅱𓏛 / 𓈙𓃀𓏴𓏛𓏥 𓈖 𓇋𓋴𓅱𓏛  | _ꞽḫ.wt n ꞽsw / šbi̯.w n ꞽsw_    | things of value / changes of price                        |
| currency                                   | 𓌉𓋞                          | _ḥḏ_                           | silver, the old medium of exchange                        |
| SCAN TRAVEL / HOW CONTAGIOUS               | 𓎛𓎛𓏭𓂻 𓈝𓏏 / 𓉻 𓈖 𓊪𓄲𓂋           | _ḥꞽḥꞽ šm.t / ꜥꜣ n pẖr_         | seek the travel / greatness of the spreading              |
| quarantine / lockdown / vaccination        | 𓈞𓋴 𓌡𓂝𓏤𓆑 / 𓐍𓏏𓋩 / 𓂋𓏙𓏏 𓎂       | _ḥmsi̯ wꜥ=f / ḫtm / rḏi̯.t zꜣ_   | sit alone / sealing / giving protection                   |
| intensive care                             | 𓌘𓁹𓁶𓏤 𓈖 𓌕𓏌                   | _rs-tp n zwn.w_                | the physician's vigilance                                 |

The licence notes on the AI World rows are translated; licence names
(CC BY 4.0, ODbL 1.0), provider and dataset names, and a citation the provider
asks for ("CelesTrak, Dr. T.S. Kelso") stay as written.

Kept as in English, on purpose (listed under `egy` in
`src/i18n/same-as-english.json`): the HUD codes, units, product, platform and
phone-model names, places, disease names (COVID-19, SARS, MERS, Ebola, Mpox),
music genres, stock indexes and currency pairs, and licence notes that are
only names ("Open-Meteo (CC BY 4.0)").

## Not translated yet

These stay English in every language for now (`data-i18n-skip`,
`src/i18n/fork-english-only.json`): SEA SURFACE TEMPERATURE (SST); POWER UP's
device, home and business camera and road CCTV key sections; the home and
business sites and shortcut pills in the LOCATION row; the CCTV panel's
picture and the LOCATION tray resize handles; the CCTV area messages. Text the
server writes is shown as it comes: model answers, a forecast's reasons and
server error details.
