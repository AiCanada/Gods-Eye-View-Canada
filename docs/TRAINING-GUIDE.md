# Training world models with God's Eye View

How to use this app to record the world, train or post-train world models on
it, and train your own language model. Everything here runs on your PC and
stays in `.gev-data/` (never committed, never uploaded).

## What you can do

- **Train a world model** on every data layer (weather, travel without
  military, traffic, hazards, news, supply ships), population demographics
  and financial assets. It predicts each place's next hours, and asset price
  moves, and draws them on the globe.
- **Keep an existing world model up to date** by post-training it on the
  newest recordings: the app's own model every day by itself, or any other
  world model through a small adapter.
- **Train or reinforcement-learn a new model of your own** from the recorded
  data and the measured interactions between data layers and assets.
- **Train a custom language model (LLM)** at the bottom of the ARTIFICIAL
  INTELLIGENCE WORLD TRAINING SIM tab, on what the app records plus your own
  URLs and files.
- **Use TensorFlow**: train a Keras world model on the same data, watch every
  training curve in TensorBoard, export TFRecords, a SavedModel and TFLite,
  and post-train a Keras model, each in its own section of the tab.
- **Use MLflow**: every training run kept and compared, models registered as
  champion or challenger, served, evaluated side by side, and a custom LLM's
  answers kept as traces, all on this PC.

## Before you start

1. Start the app the usual way (`npm run dev`). Training needs Python 3.13
   with PyTorch (`py -3.13` on Windows; `GEV_PYTHON` picks another). A GPU is
   used when there is one (an 8 GB RTX 4060 is enough).
2. If you changed the app's server code, or the AI World tab says **AI WORLD
   SERVER NOT READY**, restart `npm run dev` once.
3. Optional keys in POWER UP: `TWELVE_DATA_API_KEY` and `OILPRICE_API_KEY`
   give fresher currency and commodity quotes. Without them every asset still
   comes from Yahoo Finance.

## 1. Record, train and predict (the AI World tab)

Open **ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM**, the last tab on the left.
Drag the grip in its bottom-right corner to make it bigger; every tab on the
dashboard has the same grip (on the right-hand side it is at the bottom-left),
and a double-click on it puts the tab's own size back.

1. **TRAIN ON.** Tick what the model learns from, or **ALL**. Military
   layers and military travel are never used: they are not in the list, and
   the recorder leaves military aircraft and ships out of the civil feeds.
   **FINANCIAL ASSETS (LIVE QUOTES)** records 42 assets every five minutes:
   currencies, US yields, oil, gas, metals, grains, the main stock indexes,
   the VIX and crypto.
2. **AREAS.** Cameras, traffic, news, imagery and street level record around
   areas only. Move the map to a place and press **ADD VIEW AS AREA** (up to
   32).
3. **NEWS EVENTS.** Add any news page or RSS feed (public https). Its
   headlines are recorded and counted against the assets they name.
4. **INITIALIZE.** It shows the storage and compute estimate first; set the
   storage cap and press **CONFIRM INITIALIZE**. Recording starts.
5. **What happens next, by itself.** Each finished day is binned into hourly
   numbers per place. Then the world model trains (or post-trains) on every
   recorded day, the moving-object model trains on the tracks, and the
   layer-asset links are measured. **STATUS** shows each stage.
6. **PREDICTIONS.** A domain becomes tickable once its model is trained;
   until then it says **LEARNING** (about 7 recorded days for the world
   model). Tick **PRICE MOVES** to see each asset's predicted move drawn
   where its benchmark is set: WTI at Cushing, the TSX in Toronto, gold in
   London. Green means up, red means down, with a card at each hub. The
   **FINANCIAL ASSETS** list shows each quote with its predicted move. Set
   **HORIZON** for how far ahead. Every prediction shows its held-out score
   against persistence. None of it is advice.
7. **MEASURED links**, last under **STATUS**: which recorded channel moves
   before which asset, by how many hours, how strongly, and whether the link
   held on hours the measurement never saw. A correlation is not a cause.
8. **PAUSE / CONTINUE / STOP / DELETE.** PAUSE stops polling and saves the
   trainers where they are; CONTINUE carries on; STOP ends everything and
   keeps the data. DELETE lists exactly what it would remove and deletes
   only after a second press, on this PC only (never from your phone).

## 2. Keep an existing world model up to date (POST-TRAIN)

- **The app's own world model** post-trains itself every day on all
  recorded days, old and new, so it keeps what it learned and adds the
  newest days. When a new data layer or asset appears, the model is
  **grown**: what it knew is kept, and the new channels start from
  persistence. The status says _NEW CHANNELS: MODEL GROWN, WHAT IT KNEW
  KEPT_.
- **Another world model** (yours, or one from elsewhere):
  1. Copy `ml/adapters/kit_world.py` to `.gev-data/ai-world/adapters/<yours>.py`
     and change its four parts: load your model, take a training step on a
     batch, score a batch, save. The file explains the batch: values, masks,
     time and place features, the place graph.
  2. Put the model's checkpoint inside `.gev-data/`.
  3. In the tab's **POST-TRAIN** section, enter **ADAPTER**
     (`yours:YourClass`) and **CHECKPOINT** (its path inside `.gev-data/`),
     tick **POST-TRAIN DAILY ON NEW DATA** if you want it every day, and
     press **POST-TRAIN NOW** (the work must be initialized).
  4. The line under POST-TRAIN shows the held-out loss before and after, and
     the day the data runs to. The post-trained model is saved in
     `.gev-data/ai-world/models/posttrain/model/`; the original is not
     touched.

  From a terminal:
  `py -3.13 -m ml.gevtape.posttrain --data .gev-data --adapter yours:YourClass --checkpoint <path> --out <folder>`

## 3. Train or reinforcement-learn a new model of your own

Everything recorded is ready for your own code:

- **Export a training set:**
  `py -3.13 -m ml.gevtape.export --data .gev-data --out D:\world-set`
  (`--classes open` keeps only data you may share; `--days FIRST:LAST`). The
  folder holds the hourly arrays (`bins/YYYY/MM/DD.<group>.npy`, float32
  `[24, places, channels]`, NaN where nothing was observed), the channel
  names, the places, the assets with their hubs, the study pairs, the
  measured links, and a `DATASET.md` card. numpy alone reads it.
- **Reinforcement learning:** `ml.gevtape.world_env.WorldMarketEnv` steps
  through the recorded hours. The observation is every data layer's last
  hours and the assets' recent prices; the action is a weight per asset;
  the reward is the next hour's return, minus costs. `split="train"` and
  `split="test"` keep later hours unseen. Pass `model=` (any callable, or
  `KitWorldModel` for the app's own) to imagine episodes with a world model
  instead of replaying the tape. It follows Gymnasium's interface, and
  `as_gymnasium(env)` wraps it when gymnasium is installed.
- **Measured interactions:**
  `py -3.13 -m ml.gevtape.links --data .gev-data --out <folder>` writes every
  channel × asset × lag correlation, fitted and checked on later hours.
- **Read the bins in Python:** `ml.gevtape.torch_data.load_bin_series` and
  `BinWindows`. `docs/WORLD-MODEL-DATA.md` documents every file.

## 4. Train a custom LLM (bottom of the tab)

Open the **ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM** tab (left) and
scroll to **CUSTOM LLM TRAINING**, the last section of the tab.

1. **MODEL NAME** and **BASE MODEL.** The list under the name holds every
   open size of five model families, one group each (owner request
   2026-10-22: "Each LLM will have its own training pipeline determining the
   type of data and format"). Each size says how it fits this PC: **TRAINS
   ON THE GPU** (its weights take at most 70 % of the GPU), **GPU + RAM ·
   SLOW** (as many layers as fit go on the GPU and the rest run from RAM,
   with gradient checkpointing; minutes a step, so keep datasets and epochs
   small and post-train daily instead of retraining) or **TOO BIG FOR THIS
   PC**; and whether it is **ON THIS PC**. **Another model:** type any model
   id or folder in the box.

   Each family trains through its own pipeline (`ml/gevtape/llm_pipelines.json`,
   `ml.gevtape.llm_pipelines`): which layers the LoRA adapters go on, what
   stays frozen (vision and audio towers, perception encoders, per-layer
   embeddings, routers, routed experts), how the family's own chat template
   renders a training target with thinking off, its system-role rule, the
   data types it can take (text today; images and audio are listed for the
   families that read them, for later), and what it needs installed. The
   **PIPELINE** line under the list reads it back, for instance `GEMMA 4 ·
   TEXT, IMAGES, AUDIO · SYSTEM ROLE · THINKING OFF IN TRAINING · LORA ON
   ATTENTION AND MLP · Apache-2.0 · GPU + RAM · SLOW`. A folder you name is
   told from its `config.json`; a trained model keeps its pipeline in
   `adapter.json`, and asking it uses the same rules.

   | Family (research of 2026-10-22)                                                                                       | Sizes offered                                                                                 | Pipeline                                                                                                                                                                                                                          |
   | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **QWEN 3.5** (`Qwen/Qwen3.5-<size>`, Apache-2.0; 3 Gated DeltaNet layers to 1 Gated Attention layer, a vision encoder) | 0.8B (the default, GPU), 2B (GPU), 4B, 9B, 27B, 35B-A3B (split), 122B-A10B, 397B-A17B (too big) | adapters on `q/k/v/o_proj` and the DeltaNet `in_proj_qkv/in_proj_z/out_proj`; vision frozen; thinking is off by default and every target is rendered with `enable_thinking: false`                                                 |
   | **QWEN 3.6** (`Qwen/Qwen3.6-27B`, `Qwen/Qwen3.6-35B-A3B`, Apache-2.0; the Qwen 3.5 classes)                            | 27B, 35B-A3B (both split)                                                                     | as Qwen 3.5; thinking is on by default, so the targets are rendered with it off                                                                                                                                                   |
   | **NVIDIA NEMOTRON** (`nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`, OpenMDW-1.1; Mamba-2 + attention + MoE)     | 3.5 Lightning 30B-A3B (split); 3 Super, 3.5 Super VL, 3 Ultra (too big)                       | adapters on the attention, the Mamba `in_proj/out_proj` and the shared-expert MLP; text only; `enable_thinking: false`; EXPERIMENTAL: the fast path needs the Linux `causal-conv1d` and `mamba-ssm` kernels, Windows takes transformers' slow path |
   | **GEMMA 4** (`google/gemma-4-{E2B,E4B,12B,26B-A4B,31B}-it`, Apache-2.0; needs transformers 5.5)                        | E2B, E4B, 12B, 26B-A4B, 31B (all split on an 8 GB GPU)                                        | adapters on the attention and `gate/up/down_proj`; towers, per-layer embeddings, routers and experts frozen; a native system role; thinking is a `<\|think\|>` token at the start of the system prompt, so a target without it is a non-thinking one |
   | **META MUSE GLIMMER** (`meta-models/Muse-Glimmer-30B`, Apache-2.0; needs transformers 5.15)                            | 30B (split)                                                                                   | adapters on the attention and MLP (names to be confirmed against the installed class); the 1.8B perception encoder frozen; targets rendered with `reasoning_strength: low` and no reasoning turn; EXPERIMENTAL                     |
   | **Teachers only**: META MUSE SPARK OPEN (816B, about 530 GB) and DEEPSEEK V4 (Pro 1.6T, Flash 284B, MIT)              | none                                                                                          | too big for any training here: use them as teachers in AI DISTILLATION through OpenRouter or the custom endpoint (`docs/AI-DISTILLATION.md`)                                                                                      |

   A base must be on this PC before training, in `.gev-data/llm/base/<name>/`,
   the Hugging Face cache, or a folder you name. If it says **NOT ON THIS
   PC**, the line under it gives the one command to run in a terminal, with
   **COPY THE COMMAND**, for example
   `hf download Qwen/Qwen3.5-0.8B --local-dir .gev-data/llm/base/Qwen3.5-0.8B`
   (Muse Glimmer also needs `py -3.13 -m pip install -U transformers`; the
   line says so). The app itself never downloads a model. Sizes marked TOO
   BIG FOR THIS PC and the teacher-only families are refused before anything
   loads.

2. **DATA SOURCES.** Tick what to train from:
   - news headlines;
   - asset prices;
   - each day's headlines with the next day's price moves;
   - the measured layer-asset links;
   - the data layers' hourly readings;
   - your custom URLs;
   - your local sources;
   - the distilled answers: every ground truth from the AI DISTILLATION
     tab, the question as the prompt and the ground truth as the answer
     (`docs/AI-DISTILLATION.md`).
3. **CUSTOM URLS.** Add any public https page; its text is fetched when
   training starts.
4. **LOCAL SOURCES.** Add files or folders on this PC: text, Markdown, CSV,
   JSON lines (chat examples are used as they are), HTML, code. The app's
   own keys and folders are refused, and hidden folders are skipped.
5. **EPOCHS**, then **POST-TRAIN FROM** (a new model, or an earlier one to
   continue) and **POST-TRAIN DAILY ON NEW DATA**. Press **SAVE SETTINGS**.
6. **INITIALIZE TRAINING.** It fetches the URLs, builds the dataset (one
   example in twenty is held out) and trains. The status line shows each
   step, the epoch and the loss. **PAUSE / CONTINUE / STOP** work as in the
   tab.
7. **TRAINED MODELS** lists each model with the day its data runs to and its
   held-out loss before and after training. Ask a model from a terminal:
   `py -3.13 -m ml.gevtape.llm_chat --model .gev-data/llm/<name>/model --prompt "What moved before crude oil?"`

With POST-TRAIN DAILY, a day after each run the dataset is rebuilt from what
was recorded since, and the model is post-trained in place.

## 5. TensorFlow (the TENSORFLOW sections)

Four sections near the bottom of the tab, each folded until you open it.
Above them, **RUNS ON** says where the jobs run, and the job line shows the
one that runs, with **PAUSE / CONTINUE** and **STOP**.

1. **Once, for the GPU**: TensorFlow has no GPU on native Windows, so it runs
   in WSL2. In a terminal in the repository: `npm run tensorflow:wsl-setup`
   (Ubuntu by default; in PowerShell `$env:GEV_WSL_DISTRO = "Ubuntu-24.04"`
   picks another). It needs no password and installs Python 3.13 and
   TensorFlow into `~/.gev/` inside WSL2; the last line names the GPU. Then
   press **CHECK AGAIN**: RUNS ON reads `GPU NVIDIA … · WSL2 UBUNTU`. Without
   it, the jobs run on the CPU with `py -3.13` (`py -3.13 -m pip install
tensorflow`).
2. **TENSORFLOW TRAINING** trains a Keras world model on the binned days,
   holds out the last ones and scores it against persistence, overall and per
   domain, as the app's own world model is scored. Set **EPOCHS** and
   **DEVICE**, **SAVE**, then **TRAIN** (it carries on from the saved model)
   or **NEW MODEL** (it starts over). It needs three binned days, like the
   app's own model.
3. **TENSORBOARD**: **START TENSORBOARD**, then **OPEN TENSORBOARD**. It shows
   the curves of every trainer: the app's world, outbreak and tracks models
   and the TensorFlow ones. It opens through the app, so it works from the
   phone too. **STOP TENSORBOARD** when you are done.
4. **EXPORT FOR TENSORFLOW** writes a new folder in
   `.gev-data/ai-world/tensorflow/exports/`: the data as TFRecords, the Keras
   model as a SavedModel and as TFLite, and `TENSORFLOW.md`, which shows how
   to read it all with `tf.data`. **OPEN ONLY (SHAREABLE)** keeps only open
   data; the model still learned from every class it trained on, so the
   export says THIS PC ONLY unless both are open.
5. **POST-TRAIN A TENSORFLOW MODEL** brings a Keras model up to date on the
   newest days. The adapter `keras_world:KerasWorldAdapter` and the checkpoint
   `ai-world/tensorflow/models/tf-world` post-train the model from step 2;
   for another Keras model, copy `ml/adapters/keras_world.py` into
   `.gev-data/ai-world/adapters/`, change how it reads its inputs, and name
   its folder as the checkpoint. **SAVE**, then **POST-TRAIN NOW**; the line
   shows the held-out loss before and after.

## 6. MLflow (the MLFLOW sections)

Six sections below TENSORFLOW, each folded until you open it. MLflow is open
source (Apache 2.0) and everything stays on this PC in `.gev-data/mlflow/`;
its usage telemetry is turned off. Once: `py -3.13 -m pip install mlflow`
(about 100 to 150 MB), then CHECK AGAIN.

1. **MLFLOW TRACKING**: leave **TRACK EVERY TRAINING RUN** ticked. Every
   training run in the tab (the world, outbreak and tracks models, the
   TensorFlow jobs, the custom LLM) is kept with its settings, its loss by
   step and its held-out score against persistence per domain. The first run
   starts the MLflow server by itself.
2. **MLFLOW UI**: **START MLFLOW** (if it is not running), then **OPEN
   MLFLOW** to see the runs side by side, their charts and the registered
   models. It opens through the app, so it works from the phone too (where
   nothing can be deleted).
3. **MODEL REGISTRY**: choose a trained model, keep or change its **NAME**,
   pick **CHAMPION** (the version to use) or **CHALLENGER** (one to try) if
   you like, then **REGISTER**. Each press makes a new version. **SET ALIAS**
   moves CHAMPION or CHALLENGER to another version.
4. **MODEL SERVING**: choose a version, **START SERVING**, then **TEST**. Your
   own tools can then POST to `http://127.0.0.1:5001/invocations` (the section
   says what a request holds).
5. **EVALUATION**: **EVALUATE NOW** scores every registered world model's
   champion, challenger and newest version on the held-out days, against
   persistence, and marks the BEST; then SET ALIAS can make it the champion.
6. **LLM TRACING**: choose a custom LLM trained in part 4, type a
   **QUESTION**, **ASK**. The answer shows, and **OPEN THE TRACE** shows the
   question and the answer as a trace in MLflow.

## Licences and privacy

Every record carries its source's licence class: open, nc
(non-commercial), restricted, unclear or personal. The world model, the
export and the LLM record which classes they were trained on. Only `open`
data may be shared; the rest is for training on this PC. Nothing is
published anywhere unless you do it.

## When something does not work

- **AI WORLD SERVER NOT READY**, or CUSTOM LLM TRAINING or the TENSORFLOW
  sections are missing near the bottom of the tab: restart `npm run dev`.
- **RUNS ON · CPU ONLY** with a GPU in the PC: run `npm run
tensorflow:wsl-setup`, then CHECK AGAIN (step 5.1).
- **MLFLOW IS NOT INSTALLED**: `py -3.13 -m pip install mlflow`, then CHECK
  AGAIN. **MLFLOW SERVER · OFF (TRACKING WAITS…)**: you stopped it; START
  MLFLOW and the waiting runs go in.
- **LEARNING** under a prediction: not enough recorded days yet.
- **NO MARKET PRICES IN THE BINS YET** under STATUS: tick FINANCIAL ASSETS and
  record at least a day.
- **BASE MODEL NOT ON THIS MACHINE**: see step 4.1.
- **HELD: NO MILITARY LIST TO SCREEN AIRCRAFT WITH**: the flights feeds wait
  until the app's military aircraft list answers, so no military airframe is
  ever recorded.
