"""Where post-training adapters live and how one is loaded, for ml.gevtape.posttrain
(PyTorch) and ml.gevtape.tf_posttrain (TensorFlow) alike; nothing from either
framework is imported here.

An adapter is a Python class in a file the owner put in ml/adapters/ (this
repository) or .gev-data/ai-world/adapters/; `module:Class` names it, and
nothing else is imported.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

from .protocol import DataError

REPO_ROOT = Path(__file__).resolve().parents[2]
ADAPTER_SPEC = re.compile(r"^([a-z_][a-z0-9_]{0,63}):([A-Za-z_][A-Za-z0-9_]{0,63})$")


def adapter_dirs(data_root):
    """Where adapters may live: this repository's ml/adapters, then the owner's folder."""
    return [REPO_ROOT / "ml" / "adapters", Path(data_root) / "ai-world" / "adapters"]


def load_adapter_class(spec, data_root):
    """The class `module:Class` names, from a file in an adapter folder only."""
    match = ADAPTER_SPEC.match(str(spec or ""))
    if not match:
        raise DataError("--adapter is module:Class (a file in ml/adapters/ or .gev-data/ai-world/adapters/)")
    module, cls = match.groups()
    for folder in adapter_dirs(data_root):
        path = folder / f"{module}.py"
        if path.is_file():
            loaded = importlib.util.spec_from_file_location(f"gev_adapter_{module}", path)
            mod = importlib.util.module_from_spec(loaded)
            loaded.loader.exec_module(mod)
            found = getattr(mod, cls, None)
            if not isinstance(found, type):
                raise DataError(f"{path} has no class {cls}")
            return found, path
    raise DataError(f"no adapter {module}.py in {', '.join(str(d) for d in adapter_dirs(data_root))}")
