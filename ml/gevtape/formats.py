"""Channel names, schema strings and licence classes of the .gev-data formats.

Source of truth: docs/WORLD-MODEL-DATA.md (on-disk formats) and
docs/AI-WORLD-TAB.md (child-process protocols, the Prediction shape). The
column order is significant: index i of a channel tuple is column i of the
matching array.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# Schema strings
# --------------------------------------------------------------------------

WORLD_SCHEMA = "gev-outbreak-world/1"
DATASET_SCHEMA = "gev-outbreak-dataset/1"
EPISODE_SCHEMA = "gev-outbreak-episode/1"

# --------------------------------------------------------------------------
# Episode channels (docs/WORLD-MODEL-DATA.md, "Channels")
# --------------------------------------------------------------------------

STATE_CHANNELS = (
    "S", "E", "P", "Is", "Ia", "H", "U", "R", "D", "V",
    "E2", "P2", "Is2", "Ia2", "Rx",
)
CUM_CHANNELS = (
    "infected", "reported", "admitted", "imported", "local", "reinfected",
    "infected2",
)
AUX_CHANNELS = (
    "switchOn", "compliance", "caution", "contactsLeft", "testsUsed",
    "saturated",
)
GLOBAL_CHANNELS = (
    "infected", "reported", "deaths", "ward", "icu", "admitted",
    "restrictedPeople", "vaccinated", "countriesClosed", "imported",
    "reinfected", "distancing", "bedsShort", "restrictedPlaces",
    "icuAdmitted", "infected2", "inTransit", "pendingAdmit", "isolated",
    "globalSignal",
)
GLOBAL_ACTIONS = (
    "windowShare", "tracingIsolate", "tracingPresym", "exitScreening",
    "entryScreening", "quarantine", "importDetect", "lockdownEverywhere",
    "travelBanEverywhere",
)
COUNTRY_ACTIONS = ("borderScope", "flagged")
PLACE_ACTIONS = ("lockdown", "banned", "vaccineTarget")

# flows.npy column 4 (kind) and column 3 (mode), as documented; index = code.
FLOW_KINDS = (
    "boarded",
    "caught at exit screening",
    "caught at entry screening or quarantine (also at a hub before flying on)",
    "landed",
    "found at the gate",
    "flew on from a hub",
)
FLOW_MODES = ("air", "rail", "onward")

# events.npy column 2 (kind), as documented; index = code.
EVENT_KINDS = (
    "first arrival",
    "first report",
    "first death",
    "ten cases",
    "beds overwhelmed",
    "switch on",
    "switch off",
    "country flagged",
    "second strain seeded",
)
# The value column of a first-arrival event.
FIRST_ARRIVAL_VIA = {1: "seed", 2: "air", 3: "ground"}
EVENT_COUNTRY_FLAGGED = 7
EVENT_FIRST_ARRIVAL = 0

# Short identifiers for the same codes (the names src/outbreakEpiTape.mjs
# uses); handy as dictionary keys. Same order as the tuples above.
FLOW_KIND_IDS = ("boarded", "exitCaught", "entryCaught", "landed",
                 "foundAtGate", "flewOn")
FLOW_MODE_IDS = ("air", "rail", "onward")
EVENT_KIND_IDS = ("firstArrival", "firstReport", "firstDeath", "tenCases",
                  "overwhelmed", "switchOn", "switchOff", "countryFlagged",
                  "strain2Seeded")

# --------------------------------------------------------------------------
# World snapshot columns (docs/WORLD-MODEL-DATA.md, "World snapshot")
# --------------------------------------------------------------------------

NODE_COLUMNS = ("lat", "lon", "population", "kind", "size", "country",
                "utcOffset", "tracked")
NODE_KINDS = ("airport", "city", "origin")
# "size (0, 1 M, 2 L)": 0 is neither medium nor large.
NODE_SIZES = ("", "M", "L")
ROUTE_COLUMNS = ("from", "to", "timeOfDayMs", "lengthMs", "passengers",
                 "mode", "km")
ROUTE_MODES = ("air", "rail")
# Every file of a world but world.json, in the table's order (the worldId is
# the first 16 hex digits of a sha256 over these; reader.verify_world_id).
WORLD_FILES = ("nodes.npy", "node_ids.json", "countries.json", "routes.npy",
               "links_offsets.npy", "links_j.npy", "links_share.npy",
               "tracked.npy")
# The ones a reader cannot do without (countries.json repeats world.json's list).
WORLD_ARRAYS = tuple(f for f in WORLD_FILES if f != "countries.json")

# --------------------------------------------------------------------------
# Episode members: name -> (numpy dtype, shape). Shape entries: "T1" is
# T + 1 rows, "T" is T days, "C" countries (+1 for none), "K" tracked places,
# an int is a fixed width, None is any length.
# --------------------------------------------------------------------------

EPISODE_ARRAYS = {
    "global": ("<f8", ("T1", len(GLOBAL_CHANNELS))),
    "country_state": ("<u4", ("T1", "C", len(STATE_CHANNELS))),
    "country_cum": ("<u4", ("T1", "C", len(CUM_CHANNELS))),
    "place_state": ("<u4", ("T1", "K", len(STATE_CHANNELS))),
    "place_cum": ("<u4", ("T1", "K", len(CUM_CHANNELS))),
    "place_aux": ("<f4", ("T1", "K", len(AUX_CHANNELS))),
    "actions_global": ("<f4", ("T", len(GLOBAL_ACTIONS))),
    "actions_country": ("<f4", ("T", "C", len(COUNTRY_ACTIONS))),
    "actions_place": ("<f4", ("T", "K", len(PLACE_ACTIONS))),
    "controls_window": ("<u4", ("T",)),
    "controls_switch": ("<i4", (None, 3)),
    "controls_flags": ("<i4", (None, 2)),
    "flows": ("<i4", (None, 6)),
    "events": ("<i4", (None, 4)),
}
# The magnitudes a day's control may set: controls_magnitudes columns,
# NaN where the control left the scenario's own setting. Written by newer
# generators; an older episode has no such member.
MAGNITUDE_CONTROLS = ("lockdown", "travelBan", "testsPer1000Day", "vaccinePer1000Day")
OPTIONAL_EPISODE_ARRAYS = {
    "controls_magnitudes": ("<f8", ("T", len(MAGNITUDE_CONTROLS))),
}
# The arrays with one row per day boundary ([T + 1, ...]).
ROW_ARRAYS = ("global", "country_state", "country_cum", "place_state",
              "place_cum", "place_aux")


def expected_shape(name: str, T: int, C: int | None, K: int | None):
    """The documented shape of episode array `name` with None for free dims."""
    dims = (EPISODE_ARRAYS.get(name) or OPTIONAL_EPISODE_ARRAYS[name])[1]
    out = []
    for d in dims:
        if d == "T1":
            out.append(T + 1)
        elif d == "T":
            out.append(T)
        elif d == "C":
            out.append(C)
        elif d == "K":
            out.append(K)
        else:
            out.append(d)
    return tuple(out)


# --------------------------------------------------------------------------
# Derived groupings (inferences from the docs and src/outbreakEpi.mjs; the
# check report states which of them it relies on)
# --------------------------------------------------------------------------

# Compartments that partition a place's people. V and Rx are not in it: Rx
# is "a part of R" (docs/outbreak-epidemic-model.md, Two strains) and the
# campaign-protected V start in R as well.
POPULATION_COMPARTMENTS = ("S", "E", "P", "Is", "Ia", "H", "U", "R", "D",
                           "E2", "P2", "Is2", "Ia2")
# Infected people right now (both strains, including the hospitalised).
ACTIVE_COMPARTMENTS = ("E", "P", "Is", "Ia", "H", "U", "E2", "P2", "Is2",
                       "Ia2")

# Global channels that are the sum over countries of a country channel. The
# engine moves these per-place counters in lockstep with its global ones
# (cum <-> totalInfected, reported <-> totalReported, cumAdm <-> admitted,
# imported <-> importedTotal, reinf <-> reinfTotal, cum2 <-> strain2Total,
# D <-> deaths). ward/icu equal sum H / sum U only on the hospital path (without
# a hospital stay the engine reports a fractional Is x hospitalShare).
GLOBAL_FROM_CUM = {
    "infected": "infected",
    "reported": "reported",
    "admitted": "admitted",
    "imported": "imported",
    "reinfected": "reinfected",
    "infected2": "infected2",
}
GLOBAL_FROM_STATE = {"deaths": "D"}
GLOBAL_FROM_STATE_HOSPITAL = {"ward": "H", "icu": "U"}
# Global channels that never fall within an episode.
GLOBAL_CUMULATIVE = ("infected", "reported", "deaths", "admitted",
                     "imported", "reinfected", "icuAdmitted", "infected2")

# Features of the outbreak surrogate: log1p(state) then log1p(cum).
OUTBREAK_FEATURES = tuple(f"state.{c}" for c in STATE_CHANNELS) + tuple(
    f"cum.{c}" for c in CUM_CHANNELS)
# Features that can never fall (their predicted daily delta is >= 0).
MONOTONE_FEATURES = tuple(f"cum.{c}" for c in CUM_CHANNELS) + ("state.D",)

# --------------------------------------------------------------------------
# Licence classes (docs/WORLD-MODEL-DATA.md, "Licence classes")
# --------------------------------------------------------------------------

LICENCE_CLASSES = ("open", "nc", "restricted", "unclear", "personal", "static")
CATALOG_CLASSES = LICENCE_CLASSES  # the tab's catalog shows the same six
# What a model records when its data did not say: the most cautious class
# that still allows local training.
UNKNOWN_CLASS = "unclear"

# --------------------------------------------------------------------------
# World tape (docs/WORLD-MODEL-DATA.md, "World tape")
# --------------------------------------------------------------------------

TAPE_COMMON_FIELDS = ("t", "feed", "class", "licence")
TAPE_FEEDS = {
    "transit": ("region", "id", "route", "mode", "lat", "lon", "bearing",
                "speed"),
    "flights": ("hex", "callsign", "lat", "lon", "alt", "speed", "track",
                "vrate", "ground", "source"),
    "military": ("hex", "callsign", "type", "lat", "lon", "alt", "speed",
                 "track"),
    "vessels": ("mmsi", "name", "type", "lat", "lon", "sog", "cog",
                "heading"),
    "earthquakes": ("id", "lat", "lon", "depth", "mag", "place", "time"),
    "firms": ("lat", "lon", "frp", "confidence", "satellite", "acq"),
    "fire-perimeters": ("id", "name", "acres", "contained", "centroid",
                        "bbox"),
    "cyclones": ("id", "name", "basin", "lat", "lon", "windKt", "pressure",
                 "advisory"),
    "satellites": ("group", "name", "norad", "tle1", "tle2"),
    "rocket-launches": ("id", "name", "net", "status", "pad", "lat", "lon"),
    "bikeshare": ("system", "station", "lat", "lon", "bikes", "docks"),
    "radio": ("id", "name", "country", "lat", "lon", "tags", "codec",
              "bitrate"),
    "wind": ("model", "cycle", "step", "var", "file"),
    "news": ("source", "title", "url", "place", "lat", "lon", "published"),
}
# Feeds with moving things the track model follows: feed -> id field(s) and
# the speed / heading fields (any units; the model only sees them scaled).
TRACK_FEEDS = {
    "flights": {"id": ("hex",), "speed": "speed", "heading": "track"},
    "vessels": {"id": ("mmsi",), "speed": "sog", "heading": "cog"},
    "transit": {"id": ("region", "id"), "speed": "speed",
                "heading": "bearing"},
}

# Tape feed names that carry one of the track kinds under another name. The
# doc's table says `vessels`; scripts/world-tape-bin.mjs reads the vessels
# from `ais-live-vessels`.
TRACK_FEED_ALIASES = {"ais-live-vessels": "vessels"}


def track_kind(feed: str):
    """The track kind (a TRACK_FEEDS key) a tape feed records, or None."""
    kind = TRACK_FEED_ALIASES.get(feed, feed)
    return kind if kind in TRACK_FEEDS else None


# Military travel is not training data (owner ruling 2026-10-15): it has no
# track kind, and a military tape left from before is never read.
SKIP_TRACK_FEEDS = frozenset({"military"})


def track_trainable(feed: str) -> bool:
    """True for a civil track feed. Military flights are excluded."""
    kind = track_kind(feed)
    return kind is not None and kind not in SKIP_TRACK_FEEDS


# --------------------------------------------------------------------------
# Bins and predictions
# --------------------------------------------------------------------------

# bins/<worldId>/YYYY/MM/DD.<group>.npy columns, as documented (channels.json
# names them too and wins when the two differ).
BIN_CHANNELS = {
    "mobility": ("aircraft", "aircraftOnGround", "aircraftDepartures", "vessels",
                 "transitVehicles", "transitBuses", "transitMeanSpeed", "bikesAvailable"),
    "trains": ("railVehicles", "railMeanSpeed"),
    "traffic": ("speedRatio", "segments"),
    "weather": ("t2m", "humidity", "precip", "u10", "v10", "mslp"),
    "hazards": ("quakes", "quakeMaxMag", "fireRadiativePower", "fireDetections",
                "perimeterAcres", "cycloneDistanceKm"),
    "news": ("articles",),
    # AIS classes counted only when the type or destination says so.
    "supply": ("tankers", "cargoFood", "cargoMetal", "cargoRetail", "cargo"),
    # Headline mentions, one column per asset (src/marketAssets.mjs order).
    "news-markets": (
        "eurusd", "usdjpy", "gbpusd", "usdchf", "usdcad", "audusd", "usdcny", "usdinr",
        "usdmxn", "dxy", "us5y", "us10y", "us30y", "crude", "brent", "natgas", "gold",
        "silver", "wheat", "corn", "soybeans", "copper", "gasoline", "heatingoil",
        "jetfuel", "kerosene", "sp500", "dow", "nasdaq", "tsx", "ftse", "dax", "cac40",
        "nikkei", "hangseng", "shanghai", "sensex", "asx200", "bovespa", "vix",
        "bitcoin", "ether",
    ),
}
BIN_GROUPS = tuple(BIN_CHANNELS)
# demographics/places-<worldId>.npy: float32 [n, 5] per world place.
DEMOGRAPHICS_WIDTH = 5  # log10 population, then four shares (0-1), NaN where unknown
# demographics/abundance-<worldId>.npy: float32 [n, C] per world place: the
# GLOBAL ABUNDANCE MAP's indicators as the country's place among the others
# (0-1), then their mean; the columns are named in abundance-<worldId>.json.
PREDICTION_DOMAINS = ("outbreak", "mobility", "weather", "hazards", "news",
                      "tracks")
# Which bin groups the world model predicts for each Prediction domain.
DOMAIN_GROUPS = {
    "mobility": ("mobility", "trains", "traffic"),
    "weather": ("weather",),
    "hazards": ("hazards",),
    "news": ("news", "news-markets"),
    "supply": ("supply",),
    "markets": ("markets",),
    "news-markets": ("news-markets",),
    "air-quality": ("air-quality",),
    "stream-gauges": ("stream-gauges",),
}
# Horizons of the track model, in minutes.
TRACK_HORIZONS_MIN = (5, 15, 30, 60)

# --------------------------------------------------------------------------
# Real epidemics and policy (docs/WORLD-MODEL-DATA.md, real/owid-oxcgrt/)
# --------------------------------------------------------------------------

REAL_SCHEMA = "gev-outbreak-real/1"
REAL_OBS_CHANNELS = ("newCases", "newDeaths", "hospital", "icu", "newTests", "peopleVaccinated")
REAL_ACTION_CHANNELS = ("lockdown", "travelBan", "testing", "tracing", "vaccination")
# The outbreak surrogate's 14 action features, in its input order.
OUTBREAK_ACTIONS = (tuple(f"global.{a}" for a in GLOBAL_ACTIONS) + tuple(f"country.{a}" for a in COUNTRY_ACTIONS)
                    + tuple(f"place.{a}" for a in PLACE_ACTIONS))
# Calibration (ml.gevtape.calibrate): the real observation channels the loss
# sees, and the sim quantity each is compared with.
CALIBRATION_OBS = ("newCases", "newDeaths", "hospital", "icu")
SIM_OBSERVATION = {
    "newCases": "daily rise of cum.reported",
    "newDeaths": "daily rise of state.D",
    "hospital": "state.H",
    "icu": "state.U",
}
# Real actions that have a sim counterpart (testing has none: an extra input).
REAL_ACTION_TO_SIM = {
    "lockdown": "place.lockdown",
    "travelBan": "place.banned",
    "tracing": "global.tracingIsolate",
    "vaccination": "place.vaccineTarget",
}
