# ml/ — world-model training kit (`ml.gevtape`)

The Python side of the **Artificial Intelligence World Training Sim** tab
([docs/AI-WORLD-TAB.md](../docs/AI-WORLD-TAB.md)). It reads what the app
records under `.gev-data/` ([docs/WORLD-MODEL-DATA.md](../docs/WORLD-MODEL-DATA.md)),
checks it, trains three small models on it, answers predictions for the
globe, and validates the outbreak surrogate on real epidemics (sim
pretraining, then real fine-tuning). The server runs `train` and `serve` as
child processes; everything also works by hand.

Nothing here publishes or uploads anything: it reads `.gev-data/`, writes
only the model directory it is given, and never touches the network.

## Requirements

`py -3.13` (Python 3.13) with torch (CUDA optional; CPU works) and numpy,
both already installed. Nothing else: tar, gzip and JSON come from the
standard library (no pyarrow, datasets, zarr, h5py or gymnasium), and nothing
needs installing. Run every command from the repository root so `ml` imports
as a package.

The TensorFlow modules (`tf_*`, the AI World tab's TENSORFLOW sections) need
TensorFlow 2.21 instead of torch: on the GPU in WSL2 (`npm run
tensorflow:wsl-setup` once, then `bash scripts/tensorflow-wsl-run.sh -m
ml.gevtape.tf_train ...`), or on the CPU with `py -3.13 -m pip install
tensorflow`. They import nothing from torch, nor do `protocol`, `board`,
`adapters` or the windows of `torch_data`, so they run in a Python that has
none. Their tests (`ml/tests/test_tensorflow.py`) skip without TensorFlow.

The MLflow modules (`mlflow_*`, the tab's MLFLOW sections) need MLflow 3.17
in the Windows Python 3.13 (`py -3.13 -m pip install mlflow`); their tests
(`ml/tests/test_mlflow.py`) run against a throwaway SQLite store and skip
without it. Training never needs MLflow: the server tracks every run from its
protocol events.

## Layout

| Module                       | What it is                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gevtape/formats.py`         | channel names (STATE/CUM/AUX/GLOBAL channels, actions, flow and event kinds), schema strings, licence classes, bin channels                                                                                                                  |
| `gevtape/reader.py`          | `load_world`, `iter_episodes` (streams `shards/*.tar.gz`), `read_index`, `load_dataset_meta`, `daily_obs`, `country_graph`, `iter_tape`, `load_bins`, `load_demographics`, `load_real`, `load_worldbank`, discovery under a `.gev-data` root |
| `gevtape/check.py`           | dataset validator (CLI)                                                                                                                                                                                                                      |
| `gevtape/torch_data.py`      | `EpisodeWindows`, `BinWindows`, `TrackWindows` (IterableDatasets) and the feature functions shared with serving                                                                                                                              |
| `gevtape/models.py`          | `OutbreakSurrogate`, `WorldModel`, `TrackPredictor`                                                                                                                                                                                          |
| `gevtape/train.py`           | trainer child process (CLI)                                                                                                                                                                                                                  |
| `gevtape/serve.py`           | prediction child process (CLI)                                                                                                                                                                                                               |
| `gevtape/calibrate.py`       | the outbreak surrogate on real data: zero-shot, fine-tuned, from scratch (CLI, trainer protocol)                                                                                                                                             |
| `gevtape/env.py`             | `OutbreakEnv`, a Gymnasium-style client for `scripts/outbreak-env.mjs`                                                                                                                                                                       |
| `gevtape/synth.py`           | small synthetic `.gev-data` trees in the documented formats (tests, smoke runs)                                                                                                                                                              |
| `gevtape/geo.py`             | great-circle helpers                                                                                                                                                                                                                         |
| `gevtape/links.py`           | measured layer-asset links: lagged correlations, fitted then checked on later hours (CLI, trainer protocol)                                                                                                                                  |
| `gevtape/world_env.py`       | `WorldMarketEnv` (reinforcement learning on the recorded hours, Gymnasium-style), `KitWorldModel`, `as_gymnasium`                                                                                                                            |
| `gevtape/export.py`          | a self-contained, licence-filtered training set with its card (CLI)                                                                                                                                                                          |
| `gevtape/posttrain.py`       | post-train an existing world model through an adapter (CLI, trainer protocol)                                                                                                                                                                |
| `gevtape/llm_data.py`        | custom LLM dataset from the recordings, custom URLs and local files (CLI)                                                                                                                                                                    |
| `gevtape/llm_train.py`       | LoRA training and post-training of a local base model (CLI, trainer protocol)                                                                                                                                                                |
| `gevtape/llm_chat.py`        | ask a trained custom LLM (CLI)                                                                                                                                                                                                               |
| `gevtape/protocol.py`        | the child-process protocol (`Emitter`, `Control`, `DataError`), shared by every runner, no framework imported                                                                                                                                |
| `gevtape/board.py`           | TensorBoard scalars written with the standard library (every trainer's `--tensorboard`)                                                                                                                                                      |
| `gevtape/adapters.py`        | where post-training adapters live and how one is loaded (`module:Class`)                                                                                                                                                                     |
| `gevtape/tf_world.py`        | the Keras world model: windows as per-place rows, the model, growth to new channels, the persistence score                                                                                                                                   |
| `gevtape/tf_train.py`        | TensorFlow trainer child process (CLI, trainer protocol)                                                                                                                                                                                     |
| `gevtape/tf_export.py`       | TFRecord dataset, SavedModel and TFLite, on top of `export` (CLI, trainer protocol)                                                                                                                                                          |
| `gevtape/tf_posttrain.py`    | post-train a Keras world model through an adapter (CLI, trainer protocol)                                                                                                                                                                    |
| `gevtape/tf_probe.py`        | what this Python has: TensorFlow, TensorBoard, GPUs (one protocol line)                                                                                                                                                                      |
| `gevtape/mlflow_models.py`   | the world models (PyTorch, Keras) and a custom LLM as MLflow pyfunc models with one interface                                                                                                                                                |
| `gevtape/mlflow_register.py` | register a trained model as a new MLflow version, with an alias (CLI, trainer protocol)                                                                                                                                                      |
| `gevtape/mlflow_evaluate.py` | score registered world models against persistence on the held-out days (CLI, trainer protocol)                                                                                                                                               |
| `gevtape/mlflow_probe.py`    | what this Python has: MLflow, torch, TensorFlow, transformers (one protocol line)                                                                                                                                                            |
| `adapters/kit_world.py`      | the post-training adapter for the kit's own world model, and the template for others                                                                                                                                                         |
| `adapters/keras_world.py`    | the post-training adapter for the Keras world model, and the template for other Keras models                                                                                                                                                 |
| `tests/`                     | stdlib unittest suite                                                                                                                                                                                                                        |

## Data it reads

```
.gev-data/
  outbreak/worlds/<worldId>/            world.json, nodes.npy, node_ids.json, countries.json,
                                        routes.npy, links_*.npy, tracked.npy
  outbreak/datasets/<name>/             dataset.json, index.jsonl, shards/shard-<n>.tar.gz
  tape/<feed>/YYYY/MM/DD/HH.ndjson.gz   live feeds (tracks: flights, military, vessels
                                        or ais-live-vessels, transit)
  bins/<worldId>/YYYY/MM/DD.<group>.npy hourly features on the tracked places, channels.json
                                        (and DD.classes.json when written)
  demographics/places-<worldId>.npy     optional static features (log10 population + 4 shares)
  demographics/worldbank.json           the same shares by country (static features of real data)
  real/owid-oxcgrt/                     OWID + OxCGRT by day and country (calibrate)
  ai-world/models/<model>/              written by train: checkpoint.pt, metrics.json, manifest.json
  ai-world/models/outbreak-real/        written by calibrate: also calibration.md
```

| Model      | Trains on                                                                                   | Predicts (domains)                                                   |
| ---------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `outbreak` | sim episodes of the newest dataset's world (country level) + the world graph + demographics | `outbreak`                                                           |
| `world`    | the bins of the newest bins world                                                           | `mobility` (mobility, trains, traffic), `weather`, `hazards`, `news` |
| `tracks`   | moving things on the tape                                                                   | `tracks`                                                             |

## Commands

Check a dataset (exit 0 when no check fails, 1 otherwise; `--explain` lists
exactly what each check covers):

```
py -3.13 -m ml.gevtape.check .gev-data/outbreak/datasets/<name> [--world <dir>] [--limit N] [--json]
```

The world is found through `../../worlds/<worldId>` when `--world` is not
given. Checked: schema strings, documented dtypes and shapes, every row's
Σ tracked places + rest = country (rest ≥ 0, exact where a country is fully
tracked) and Σ countries = global for the channels the engine counts in
lockstep (infected, reported, admitted, imported, reinfected, infected2,
deaths; ward/icu on the hospital path), counts never negative (a negative
written as uint32 shows as ≥ 2³¹), cumulative channels never falling,
actions in [0, 1], controls/flows/events in range (and, when an episode
has the optional `controls_magnitudes`, its shape, with a warning for a
magnitude outside its range), the two arms of a pair equal on row 0, and
the licence classes.

Train (what the server runs, plus options for hand use):

```
py -3.13 -m ml.gevtape.train --data .gev-data --model outbreak --out .gev-data/ai-world/models/outbreak
    [--epochs 10] [--resume] [--device auto|cpu|cuda] [--batch-size N] [--lr X] [--hidden 64]
    [--context N] [--horizon N] [--dataset NAME] [--world-id ID] [--workers N] [--bf16]
    [--max-batches N] [--log-every N] [--sleep-ms N] [--seed N]
```

`--context`/`--horizon` are days for `outbreak` (default 7/7, shrunk to fit
short episodes), hours for `world` (24/24). stdout carries only protocol
lines; stdin takes `{"cmd":"pause"}` and `{"cmd":"stop"}`:

| stdout event                                                             | when                                      |
| ------------------------------------------------------------------------ | ----------------------------------------- |
| `{"event":"progress","model","epoch","epochs","step","loss"}`            | every `--log-every` steps (epoch 1-based) |
| `{"event":"metrics","skill":{"metric":"mae","model","persistence"},...}` | after each epoch's held-out evaluation    |
| `{"event":"checkpoint","path"}`                                          | after each epoch, and on pause / stop     |
| `{"event":"paused"}` / `{"event":"done"}`                                | then exit 0                               |
| `{"event":"error","message"}`                                            | then exit 1                               |

Pause and stop take effect at the next step boundary: checkpoint, then
`paused` (pause) or `done` (stop), exit 0. `--resume` continues from
`checkpoint.pt` exactly (same batches, bit-identical weights to an
uninterrupted run; tested). `--resume` on a finished run trains another
`--epochs` from its weights on the data there is now: that is how the
server's daily retrain picks up new days.

Serve:

```
py -3.13 -m ml.gevtape.serve --data .gev-data --models .gev-data/ai-world/models [--device cpu]
```

One JSON request per stdin line, one answer per stdout line:

```
{"id":1,"cmd":"ping"}  ->  {"id":1,"ok":true,"result":{"models":[{name, kind, domains, epoch, step, updatedAt, classes, skill}]}}
{"id":2,"cmd":"predict","domain":"weather","horizon":24,"bbox":"w,s,e,n"}  ->  {"id":2,"ok":true,"result":Prediction}
{"id":3,"cmd":"reload"}   {"id":4,"cmd":"close"}
```

`horizon` is hours; `bbox` is `"w,s,e,n"`, `[w,s,e,n]` or null (w > e
crosses the antimeridian). Optional: `"channel"` picks the heat value
(outbreak: `active` (default), or a feature such as `cum.infected` / `D`;
world domains: the domain's first channel by default, or e.g. `t2m`),
`"dataset"` / `"episode"` pick the outbreak starting point. Without a model,
or without enough history, the answer is a Prediction with
`learning: {daysRecorded, needed}` and no points or tracks.

| Domain                           | Starting point and output                                                                                                                                                                                               | `learning` when missing                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| outbreak                         | the newest arm-A episode of the newest dataset, rolled on `ceil(horizon/24)` days with its last day's decisions held; each country's predicted active infections spread over its tracked places by their infections now | `daysRecorded`: days per episode of the newest dataset; `needed`: the model's context + horizon (14 without one) |
| mobility, weather, hazards, news | the world model over the last recorded hours of bins, `horizon` hours on (≤ 168); one point per tracked place that observed the channel in the context                                                                  | bin days with the domain's groups; 7                                                                             |
| tracks                           | the last two hours of each track feed's newest tape; tracks seen in the last 15 minutes; path = last fix, then 5 / 15 / 30 / 60 min (those ≤ horizon)                                                                   | tape days of track feeds; 1                                                                                      |

Calibrate the outbreak surrogate on real data (needs a trained
`outbreak` model and `real/owid-oxcgrt/`):

```
py -3.13 -m ml.gevtape.calibrate --data .gev-data --model-dir .gev-data/ai-world/models/outbreak
    --out .gev-data/ai-world/models/outbreak-real [--epochs 10] [--device auto|cpu|cuda] [--resume]
    [--context 14] [--horizon 7] [--smooth 7] [--val-fraction 0.2] [--lr 1e-3] [--batch-size 8]
```

Same stdout/stdin protocol as `train` (events carry `phase`: zero-shot,
finetune, scratch, summary; `epochs` counts both training phases, so 2 x
`--epochs`; `--resume` continues exactly, in either phase). See
"Real-data calibration" below for what it compares and how.

Synthetic data (handy for smoke runs; not real data):

```
py -3.13 -m ml.gevtape.synth <out_root> [--scenarios 3] [--runs 2] [--days 12] [--bin-days 4] [--tape-hours 3]
    [--demographics] [--real-days 120]
```

Environment client (needs `scripts/outbreak-env.mjs` and a world snapshot):

```python
from ml.gevtape.env import OutbreakEnv, window_mask
with OutbreakEnv() as env:                     # node scripts/outbreak-env.mjs, repo root
    obs, info = env.reset(seed=1)              # obs: numpy arrays as the env sends them
    obs, reward, terminated, truncated, info = env.step({"window": window_mask(range(8, 20)), "flag": [3]})
    # How hard, too (each optional): lockdown and travelBan 0-1, tests and doses a day per 1,000.
    env.step({"window": 0xFFFFFF, "lockdown": 0.6, "travelBan": 0.5, "vaccinePer1000Day": 5})
```

The protocol has no reward; `reward_fn(prev_obs, obs, info)` supplies it
(default: `info["reward"]` if sent, else minus the day's new infections).
`obs["global"]` is passed through as sent (the 20 GLOBAL_CHANNELS, or the
earlier shorter vector); `OutbreakEnv.named_global(obs)` names the 20.

Tests (about 40 s on CPU):

```
py -3.13 -m unittest discover -s ml/tests -t .
```

## Models and metrics

All three are small (hidden 64 by default: well inside an 8 GB GPU; tested
on CPU).

- **OutbreakSurrogate** — per-country GRU over days; each step reads its
  neighbours' states through the country graph (passengers a day between
  countries, log1p, row-normalised) and refines its output with one round of
  message passing (`--rounds`). Inputs: log1p of [state, cum] (22), the
  day's actions (global 9 + country 2 + the country's tracked places'
  population-weighted place actions 3), static features (log population,
  demographic shares when recorded). Output: next-day log1p deltas;
  cumulative channels and D get a softplus delta so they never fall. The
  output layer starts at zero, so an untrained model is persistence.
  Held-out split: by scenario (both arms and every run stay together).
- **WorldModel** — the same pattern over the tracked places (graph: routes
  between tracked places plus 4 nearest neighbours) on hourly bins,
  sign(x)·log1p(|x|) scaled, with an observed mask per value; predicts the
  last observed value plus a learned change. Held out: the last days.
- **TrackPredictor** — constant velocity along the great circle through
  the last two fixes, plus a GRU residual over the last 8 fixes (positions
  in an azimuthal-equidistant frame on the last fix, time gaps, reported
  speed and heading, feed). Held out: the last tape day (one day: a fifth of
  the track ids).

`metrics.json` holds `skill: {metric: 'mae', model, persistence}` on held-out
data: outbreak in log1p people over the countries the outbreak has reached
(`skillAllCountries` over all), plus `counterfactual` (median |predicted −
simulated| difference in final infected between arms B and A, over paired
held-out episodes rolled from row 0); world in symlog units per domain;
tracks in great-circle km (plus `constantVelocity`).

## Real-data calibration (`calibrate`)

Pretrained on sim episodes, the surrogate is compared on the held-out last
20 % of days of `real/owid-oxcgrt/` (a time split: 2022-05-27 to 2022-12-31
for the 2020-2022 set) in three forms: **zero-shot** (the sim surrogate as
trained, never shown real data), **fine-tuned** (those weights trained on
the real training days) and **from scratch** (the same architecture,
fresh weights, the same training). The score is the mean absolute error of
7-day forecasts from 14 days of context, over the observed cells only, in
log1p of people per 100,000 (population from `population.npy`, else the
world snapshot; a country with neither is left out), against persistence
(the last observed value). Results go to `metrics.json` (`zeroShot`,
`fineTuned`, `scratch`, each by channel and horizon day) and `calibration.md`.

| real channel | sim surrogate                |
| ------------ | ---------------------------- |
| newCases     | daily rise of `cum.reported` |
| newDeaths    | daily rise of `state.D`      |
| hospital     | `state.H` (ward occupancy)   |
| icu          | `state.U`                    |

New cases and deaths are 7-day trailing means (`--smooth`). Actions:
lockdown → `place.lockdown`, travelBan → `place.banned`, tracing →
`global.tracingIsolate`, vaccination → `place.vaccineTarget`, any action on
→ `global.windowShare` = 1; testing has no sim counterpart and is an extra
input. Extra inputs (testing, whether actions and observations exist, test
volumes, the day's observations, and the daily growth that would repeat
them) enter through new encoder columns at zero weight, so zero-shot is the
sim model exactly. The surrogate's other inputs are its 22 log1p state
features, which real data mostly does not observe: they are reconstructed
crudely from the case rate (`calibrate.py` lists the rules). The fine-tuned
and scratch models also get a linear path from the growth inputs to the
output, set to repeat the day's counts exactly (they start at persistence
and learn corrections); training runs like the evaluation (context from the
data, the days ahead on the model's own predictions), with a channel-balanced
masked Huber loss and cosine learning-rate decay.

First run on the real set (base: a surrogate trained 2 epochs on the
10-day smoke dataset; 10 + 10 epochs, about 50 s on the RTX 4060): MAE
zero-shot 0.794, fine-tuned 0.106, from scratch 0.104, persistence 0.099.
Zero-shot transfer is poor with that base; both trained forms stay close to
persistence (better on cases at longer horizons, worse on hospital and ICU,
where the sim's ward dynamics pull the fine-tuned model off). A base trained
on a full sweep is the next thing to try.

## Licence classes

Every model's `manifest.json` lists the licence classes of the data it
trained on (`licenceClasses`, and `openOnly`): the dataset's `classes`
(the world's too), the bins' (from `channels.json` if it says, else each
feed's `class` on the tape those days), demographics as `open` (World Bank
WDI, CC BY 4.0), the tape records' `class` for tracks. Data that does not say
counts as `unclear`. The calibrated model's manifest takes the real data's
class (`open`) and the base model's, and carries the OWID and OxCGRT
attributions from `meta.json` (`attributions`). Per the doc, only `open`
data may ever enter something published, and only with the owner's say;
this kit trains locally and publishes nothing.

## Formats: what the kit assumes beyond the doc

- **worldId**: verified as the producer builds it (every world file but
  world.json, sorted by name, each name hashed before its bytes); the doc
  does not fix the construction, so a mismatch is only a warning.
- **dataset.json**: `days`/`runs` under `spec` (as documented; the top level
  is accepted with a warning); classes in `classes` (licence texts in
  `licences`).
- **index.jsonl**: `shard` as a number (any zero padding) or a file name;
  pairs come from the keys (`pair` is the shared scenario-run id).
- **Σ country = global**: the channel mapping comes from the engine's
  lockstep counters (src/outbreakEpi.mjs); `vaccinated` ≤ Σ V is a warning
  only (V is caught up for untouched places, the engine's counter is not).
- **bins**: `channels.json` at `bins/<worldId>/channels.json`
  (`{group: [channels]}`); a per-day `DD.channels.json` would win. Licence
  classes from `YYYY/MM/DD.classes.json` (`{group: [classes seen]}`) when
  present, else `channels.json`, else the tape's records.
- **world.json**: `classes` when present (newer worlds); without it the
  check warns and the classes come from the dataset.
- **tape**: `class` is the record's licence class.
- **real/owid-oxcgrt**: values where a mask is 0 are treated as missing
  whatever they hold; channel names from `meta.json` `channels.obs` /
  `channels.actions`; the licence class from `class` (or `classes`).
