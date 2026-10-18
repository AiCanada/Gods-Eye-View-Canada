#!/usr/bin/env bash
# TensorFlow on the GPU for the AI World tab's TensorFlow sections, in WSL2.
# TensorFlow on native Windows has had no GPU since 2.11, so its GPU runs go
# through WSL2. This sets up, in the WSL user's home and without sudo:
#   ~/.gev/uv-boot   uv, which fetches Python 3.13 and the packages
#   ~/.gev/tf-venv   Python 3.13 with tensorflow[and-cuda], TensorBoard, numpy
# The Windows NVIDIA driver already gives WSL2 the GPU; CUDA comes as wheels.
#
#   npm run tensorflow:wsl-setup        (from Windows: scripts/tensorflow-wsl-setup.mjs
#                                        runs this in the GEV_WSL_DISTRO distro, Ubuntu
#                                        by default)
#   bash scripts/tensorflow-wsl-setup.sh  (inside WSL2 or on Linux)
#
# Safe to run again: it keeps what is there and adds what is missing.
set -euo pipefail

TF_VERSION="${GEV_TF_VERSION:-2.21.0}"
GEV_HOME="$HOME/.gev"
UV="$GEV_HOME/uv-boot/bin/uv"
VENV="$GEV_HOME/tf-venv"

mkdir -p "$GEV_HOME"
if [ ! -x "$UV" ]; then
  echo "Installing uv into $GEV_HOME/uv-boot"
  python3 -m venv "$GEV_HOME/uv-boot"
  "$GEV_HOME/uv-boot/bin/pip" install --quiet --upgrade pip uv
fi

"$UV" python install 3.13
if [ ! -x "$VENV/bin/python" ]; then
  "$UV" venv --python 3.13 "$VENV"
fi
"$UV" pip install --python "$VENV/bin/python" \
  "tensorflow[and-cuda]==$TF_VERSION" tensorboard numpy

# The GPU check goes through the launcher the app uses (CUDA wheels on the path).
bash "$(dirname "$0")/tensorflow-wsl-run.sh" -c "
import sys, tensorflow as tf
gpus = [gpu.name for gpu in tf.config.list_physical_devices('GPU')]
print('TensorFlow', tf.__version__, '- Python', sys.version.split()[0], '- GPUs', gpus or 'none')
"
