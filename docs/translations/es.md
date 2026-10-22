# Spanish (`es`)

Catalog: `src/i18n/locales/es.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Neutral Spanish that reads naturally in Spain and Latin America; avoid regionalisms.
- Address the user with informal "tú" imperatives: «Añade», «Activa», «Elige», «Pega», «Inténtalo de nuevo». Tooltips that name an action may use the infinitive: «Expandir el panel», «Restablecer la cámara».
- Sentence case, not Title Case: "Live Flights" → «Vuelos en vivo». UPPERCASE English stays UPPERCASE: «EN VIVO», «SIN DATOS».
- Quotes inside Spanish text are straight double quotes: «¿Eliminar el plano "{shot}"?». Questions and exclamations open with ¿ and ¡.
- Short labels, chips and HUD readouts stay short. A standard abbreviation with a period beats a wrapped line: ANT., SIG., VEL., DIST., SINCR., cám., cob.
- The HUD codes HDG, BRG, CRS, FOV, DEST, SPD, RANGE and ALT stay in English everywhere, as in cockpit avionics. Words used in a sentence are translated: heading → «rumbo», range → «alcance».
- Keyboard keys stay in English: Space, Esc, Enter, Tab, Shift, H, 1–9 («Mantén pulsado Space para hablar»).
- Units: km, m, km/h, m/s, kn (knots), ft (feet), h, min, s; in UPPERCASE text KM, KM/S, KN, FT, MIN, H. "m" is always metres, so minutes are «min» («hace 5 min»). MW stays MW. `°` and `%` stay.
- "ago" goes before the time: «hace {count} min». When a placeholder already holds a localized "ago" text (`{age}`, `{ago}`), do not add «hace» again.
- Spelling: «costo» (not «coste»).

## Plurals

A `tn()` entry needs three forms. `Intl.PluralRules('es')` picks:

| Form    | Counts                                 | Example              |
| ------- | -------------------------------------- | -------------------- |
| `one`   | 1                                      | 1 cámara             |
| `many`  | 1 000 000, 2 000 000… (exact millions) | 1 000 000 de cámaras |
| `other` | everything else: 0, 2–999 999, 1.5…    | 3 cámaras            |

The `many` form is the `other` text with «de» after the number: «{count} de cámaras cargadas», «{count} DE CLAVES EN ESPERA».

## Glossary

| English                                       | Español                                                           |
| --------------------------------------------- | ----------------------------------------------------------------- |
| layer / data layer                            | capa / capa de datos                                              |
| feed / source / data source                   | fuente / fuente / fuente de datos                                 |
| LIVE (status) / live data                     | EN VIVO / datos en vivo                                           |
| SIMULATED                                     | SIMULADO                                                          |
| stale / degraded / unavailable                | desactualizado / degradado / no disponible                        |
| retry / retrying                              | reintento / reintentando                                          |
| key (API key) / POWER UP / POWERED UP         | clave / ENCENDER / ENCENDIDO                                      |
| Provider Settings                             | Ajustes de proveedores                                            |
| ON / OFF (state chips)                        | ACTIVO / INACTIVO (short enough for the layer pill)               |
| enable / disable                              | activar / desactivar                                              |
| globe / map / map source / map stack          | globo / mapa / fuente del mapa / conjunto de mapas                |
| aircraft, plane / flight / military flights   | aeronave / vuelo / vuelos militares                               |
| vessel, ship                                  | buque                                                             |
| satellite / shell (Starlink) / DENSE          | satélite / capa / DENSO                                           |
| launch (rocket) / launch site / space mission | lanzamiento / lugar de lanzamiento / misión espacial              |
| ascent / replay / payload / stage             | ascenso / repetición / carga útil / etapa                         |
| contact / tracking                            | contacto / rastreo                                                |
| installation / site                           | instalación / sitio                                               |
| mapped / observed                             | mapeado / observado                                               |
| camera / CCTV camera                          | cámara / cámara CCTV                                              |
| earthquake / active fire                      | terremoto / incendio activo                                       |
| radio station                                 | emisora                                                           |
| road / flow (traffic)                         | vía / flujo                                                       |
| scene / shot / scene recipe                   | escena / plano / receta de escena                                 |
| briefing / panel / dock                       | información / panel / dock                                        |
| cockpit                                       | cabina                                                            |
| preset / visual preset                        | preajuste / preajuste visual                                      |
| Scope (circular viewport mask) / keyhole      | mirilla / ojo de cerradura                                        |
| feather / fade                                | difuminado / desvanecimiento                                      |
| detection overlay                             | superposición de detección                                        |
| pin (Draw tool)                               | marcador                                                          |
| Bloom / Glow (visual effect)                  | resplandor                                                        |
| Cyber (HUD layout, effect)                    | Ciber                                                             |
| heading, course / altitude / ground speed     | rumbo / altitud / velocidad respecto al suelo (short: VEL. SUELO) |
| HDG / BRG / CRS / FOV / DEST / SPD / RANGE    | HDG / BRG / CRS / FOV / DEST / SPD / RANGE (unchanged)            |
| PREV / NEXT                                   | ANT. / SIG.                                                       |
| Previous / Next (button text)                 | Anterior / Siguiente                                              |
| L / R (relative bearing)                      | I / D                                                             |
| SIG / NEWS / LOCAL (briefing tabs)            | SIG / NOTICIAS / LOCAL                                            |
| PITCH / HGT (CCTV calibration chips)          | INCL. / ALT.                                                      |
| NOT AN ALL-CLEAR                              | NO IMPLICA TODO DESPEJADO                                         |
| click / click to …                            | haz clic / clic para …                                            |

## The fork's own tabs

Spanish is listed in `src/i18n/fork-locales.json` (owner request,
2026-10-19: "Finish coding for all Espanola"), so it also translates God's
Eye View Canada's tabs on the left, what they draw on the globe and the
POWER UP chip's count; Russian shows them in English ([I18N.md](../I18N.md),
"The fork's own tabs"). Their glossary:

| English                                       | Español                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| AI RISK & TRUTH ASSESSMENT (tab)              | EVALUACIÓN DE RIESGO Y VERDAD CON IA                             |
| ULTRA SECURITY PACKAGE / package              | PAQUETE DE SEGURIDAD ULTRA / paquete                             |
| SOCIAL MEDIA ANALYSIS                         | ANÁLISIS DE REDES SOCIALES                                       |
| OUTBREAK LOCATIONS & PREDICTED SPREAD         | LUGARES DE BROTES Y PROPAGACIÓN PREVISTA                         |
| ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM    | SIMULADOR DE ENTRENAMIENTO DEL MUNDO CON INTELIGENCIA ARTIFICIAL |
| AI DISTILLATION                               | DESTILACIÓN DE IA                                                |
| POWER UP (in a sentence)                      | ENCENDER, as the chip reads                                      |
| this PC / this computer                       | este PC                                                          |
| outbreak / spread / commuting                 | brote / propagación / desplazamientos diarios                    |
| SCAN TRAVEL / HOW CONTAGIOUS                  | ESCANEAR VIAJES / NIVEL DE CONTAGIO                              |
| superspreading / fatality / lockdown          | supercontagio / letalidad / confinamiento                        |
| SEND HELP / STAND DOWN / EXTEND HELP          | PEDIR AYUDA / FIN DE ALERTA / PROLONGAR AYUDA                    |
| helper / token / token holder                 | ayudante / token / destinatario del token                        |
| Ultra cell                                    | teléfono Ultra                                                   |
| NETWORK ON / NETWORK OFF / HELP NETWORK       | RED ACTIVA / RED INACTIVA / RED DE AYUDA                         |
| home list (UPDATE HOME LIST)                  | mi lista (ACTUALIZAR MI LISTA)                                   |
| skill / CONFIRMED / NO CONFIRMATION           | habilidad / CONFIRMADO / SIN CONFIRMACIÓN                        |
| REJECTED CLAIM                                | AFIRMACIÓN RECHAZADA                                             |
| bot / swarm / Chief of Staff                  | bot / enjambre / jefe de gabinete                                |
| check-ins (social platforms)                  | registros de visitas                                             |
| world model / train / post-train              | modelo del mundo / entrenar / postentrenar                       |
| binned day / BINNING / bins                   | día agregado / AGREGANDO / agregados                             |
| epoch / loss / held-out                       | época / pérdida / reservado (datos reservados)                   |
| checkpoint / adapter / INFER                  | punto de control / adaptador / INFERIR                           |
| FINANCIAL ASSETS / PRICE MOVES                | ACTIVOS FINANCIEROS / MOVIMIENTOS DE PRECIOS                     |
| licence classes OPEN, NC, RESTRICTED, UNCLEAR | ABIERTA, NC, RESTRINGIDA, INCIERTA                               |
| PERSONAL, STATIC                              | PERSONAL, ESTÁTICA                                               |
| ground truth / teacher / reviewer / writer    | verdad fundamental / profesor / revisor / redactor               |
| student / upgrade (an answer)                 | alumno / mejorar                                                 |
| heading (AI DISTILLATION) / prompt            | sección / prompt                                                 |
| adversarial review / grade                    | revisión adversaria / calificar                                  |
| run (a job) / call (a paid request)           | ejecución / llamada                                              |

The MLflow aliases CHAMPION and CHALLENGER stay in English: they are the
names the registry stores. The licence notes on the AI World rows are
translated; licence names (CC BY 4.0, ODbL 1.0), provider and dataset names,
and a citation the provider asks for ("CelesTrak, Dr. T.S. Kelso") stay as
written. Card names on POWER UP's cards stay in English, as in every
language: GROK BOT, GROK BOT — COMPUTER, OPENAI DOTS, SMS RELAY, OPENSKY.
What stays English in every language for now is listed under "Not translated
yet" in [fr-CA.md](./fr-CA.md).
