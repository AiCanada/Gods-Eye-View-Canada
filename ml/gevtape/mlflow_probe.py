"""Whether this Python has MLflow, for the AI World tab's MLFLOW sections: one
protocol line, {"event":"probe","python","mlflow","torch","tensorflow","transformers"}.

    python -m ml.gevtape.mlflow_probe

A missing package is null, never an error. Nothing is imported past its version.
"""

from __future__ import annotations

import importlib.metadata as md
import sys

from .protocol import Emitter


def version(name):
    try:
        return md.version(name)
    except md.PackageNotFoundError:
        return None


def main() -> int:
    Emitter(sys.stdout)("probe", python=sys.version.split()[0], mlflow=version("mlflow"),
                        torch=version("torch"), tensorflow=version("tensorflow"),
                        transformers=version("transformers"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
