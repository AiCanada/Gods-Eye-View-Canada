"""gevtape: read, check, learn from and serve the .gev-data world-model tape.

Formats: docs/WORLD-MODEL-DATA.md. Child-process protocols and the
Prediction shape: docs/AI-WORLD-TAB.md. Modules:

- formats     channel names, schema strings, licence classes
- reader      worlds, episodes (tar.gz shards), index, tape, bins
- check       validate a dataset (CLI: python -m ml.gevtape.check)
- geo         great-circle helpers for the track model
- torch_data  IterableDatasets of training windows
- models      OutbreakSurrogate, WorldModel, TrackPredictor
- train       trainer child process (CLI: python -m ml.gevtape.train)
- serve       prediction child process (CLI: python -m ml.gevtape.serve)
- env         client for the closed-loop outbreak environment
- synth       small synthetic data in the documented formats
"""

__version__ = "0.1.0"
