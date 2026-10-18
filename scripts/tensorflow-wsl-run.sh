#!/usr/bin/env bash
# Runs the WSL2 TensorFlow Python (scripts/tensorflow-wsl-setup.sh) from the
# repository root, with the CUDA libraries of its wheels on the library path:
# without them TensorFlow cannot open libcusolver and falls back to the CPU.
#
#   bash scripts/tensorflow-wsl-run.sh -m ml.gevtape.tf_train --data ... --out ...
set -euo pipefail

VENV="$HOME/.gev/tf-venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "No TensorFlow Python in $VENV: run npm run tensorflow:wsl-setup" >&2
  exit 3
fi
NVIDIA="$VENV/lib/python3.13/site-packages/nvidia"
if [ -d "$NVIDIA" ]; then
  LIBS=$(ls -d "$NVIDIA"/*/lib 2>/dev/null | paste -sd: -)
  export LD_LIBRARY_PATH="$LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export TF_CPP_MIN_LOG_LEVEL="${TF_CPP_MIN_LOG_LEVEL:-2}"
export PYTHONIOENCODING=utf-8
cd "$(dirname "$0")/.."
exec "$VENV/bin/python" "$@"
