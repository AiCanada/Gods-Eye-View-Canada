"""What this Python can do for the AI World tab's TensorFlow sections: one
protocol line, {"event":"probe","python","tensorflow","tensorboard","gpus"}.

    python -m ml.gevtape.tf_probe

server/shared/tensorflowJobs.mjs runs it in the WSL2 Python
(scripts/tensorflow-wsl-run.sh) and in the Windows one, and trains where
there is a GPU. A missing package is null, never an error.
"""

from __future__ import annotations

import os
import sys

from .protocol import Emitter


def probe() -> dict:
    out = {"python": sys.version.split()[0], "platform": sys.platform, "tensorflow": None, "tensorboard": None,
           "gpus": []}
    try:
        import tensorboard

        out["tensorboard"] = getattr(tensorboard, "__version__", None) or "?"
    except ImportError:
        pass
    try:
        import tensorflow as tf
    except ImportError as e:
        out["error"] = f"no tensorflow: {e}"
        return out
    out["tensorflow"] = tf.__version__
    for gpu in tf.config.list_physical_devices("GPU"):
        try:
            name = tf.config.experimental.get_device_details(gpu).get("device_name")
        except (RuntimeError, ValueError, AttributeError):
            name = None
        out["gpus"].append(name or gpu.name)
    return out


def main() -> int:
    Emitter(sys.stdout)("probe", **probe())
    return 0


if __name__ == "__main__":
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")  # before TensorFlow is imported
    sys.exit(main())
