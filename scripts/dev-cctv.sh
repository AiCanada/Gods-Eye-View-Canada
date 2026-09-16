#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A lighter CCTV testing preset: only the small Austin source file. Startup,
# credentials, and LAN warnings belong to the normal launcher. Pack caps and
# preferences are gone; the server's fixed area cap (1,000 nearest within
# 50 km) applies. Explicit environment overrides remain supported.
export CCTV_SOURCES_FILE="${CCTV_SOURCES_FILE:-config/cctv_sources.austin.json}"

exec bash "$ROOT_DIR/scripts/dev-fresh.sh"
