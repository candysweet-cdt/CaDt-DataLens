#!/usr/bin/env bash
set -euo pipefail

BIN="build/bin/CaDt-DataLens.exe"
if [[ ! -x "$BIN" ]]; then
  echo "missing $BIN" >&2
  exit 1
fi

echo "starting CaDt-DataLens"
"$BIN" "$@"
