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
- **Train a custom language model (LLM)** from POWER UP, on what the app
  records plus your own URLs and files.

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
7. **LINKS.** The study pairs (news and prices, ships and commodities,
   traffic and fuel, weather and wheat, flights and jet fuel), and below
   them the **measured** links: which recorded channel moves before which
   asset, by how many hours, how strongly, and whether the link held on
   hours the measurement never saw. A correlation is not a cause.
8. **PAUSE / CONTINUE / STOP / DELETE.** PAUSE stops polling and saves the
   trainers where they are; CONTINUE carries on; STOP ends everything and
   keeps the data. DELETE lists exactly what it would remove and deletes
   only after a second press, on this PC only (never from your phone).

## 2. Keep an existing world model up to date (POST-TRAIN)

- **The app's own world model** post-trains itself every day on all
  recorded days, old and new, so it keeps what it learned and adds the
  newest days. When a new data layer or asset appears, the model is
  **grown**: what it knew is kept, and the new channels start from
  persistence. The status says *NEW CHANNELS: MODEL GROWN, WHAT IT KNEW
  KEPT*.
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

## 4. Train a custom LLM (POWER UP)

Open **POWER UP** (bottom right) and scroll to **CUSTOM LLM TRAINING**.

1. **MODEL NAME** and **BASE MODEL.** Choose the base in the list under
   the name:
   - **Qwen3.5-0.8B** (`Qwen/Qwen3.5-0.8B`, the default, Apache-2.0,
     1.7 GB) trains on the GPU alone. A small dataset takes about a minute.
   - **Qwen3.6-35B-A3B** (`Qwen/Qwen3.6-35B-A3B`, Apache-2.0) is the large
     option: a mixture-of-experts model with 35 B parameters, about 3 B
     active for each token, and about 72 GB of weights. It does not fit an
     8 GB GPU, so it is split. As many layers as fit go on the GPU and the
     rest run from RAM (it needs about 85 GB free of the 128 GB), with
     gradient checkpointing. It is slow (minutes a step): keep datasets and
     epochs small, and post-train daily instead of retraining.
   - **Another model:** type any model id or folder in the box.

   The list says which bases are on this PC. A base must be there before
   training, in `.gev-data/llm/base/<name>/`, the Hugging Face cache, or a
   folder you name. If it says **NOT ON THIS PC**, fetch it once in a
   terminal, for example
   `hf download Qwen/Qwen3.5-0.8B --local-dir .gev-data/llm/base/Qwen3.5-0.8B`.
   The app itself never downloads a model.
2. **DATA SOURCES.** Tick what to train from:
   - news headlines;
   - asset prices;
   - each day's headlines with the next day's price moves;
   - the measured layer-asset links;
   - the data layers' hourly readings;
   - your custom URLs;
   - your local sources.
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

## Licences and privacy

Every record carries its source's licence class: open, nc
(non-commercial), restricted, unclear or personal. The world model, the
export and the LLM record which classes they were trained on. Only `open`
data may be shared; the rest is for training on this PC. Nothing is
published anywhere unless you do it.

## When something does not work

- **AI WORLD SERVER NOT READY**, or the POWER UP section is missing:
  restart `npm run dev`.
- **LEARNING** under a prediction: not enough recorded days yet.
- **NO MARKET PRICES IN THE BINS YET** under LINKS: tick FINANCIAL ASSETS and
  record at least a day.
- **BASE MODEL NOT ON THIS MACHINE**: see step 4.1.
- **HELD: NO MILITARY LIST TO SCREEN AIRCRAFT WITH**: the flights feeds wait
  until the app's military aircraft list answers, so no military airframe is
  ever recorded.
