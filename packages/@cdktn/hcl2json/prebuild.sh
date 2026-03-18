#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

set -euo pipefail

GOROOT="${GOROOT:-$(go env GOROOT)}"

if [[ -z "${GOROOT-}" ]]; then
  echo "GOROOT environment variable needs to be set!"
  exit 1
fi

WASM_EXEC_PATH=""
if [ -f "$GOROOT/misc/wasm/wasm_exec.js" ]; then
    WASM_EXEC_PATH="$GOROOT/misc/wasm/wasm_exec.js"
elif [ -f "$GOROOT/lib/wasm/wasm_exec.js" ]; then
    WASM_EXEC_PATH="$GOROOT/lib/wasm/wasm_exec.js"
else
    echo "File wasm_exec.js does not exist under either \$GOROOT/misc/wasm/ or \$GOROOT/lib/wasm/!"
    exit 1
fi

cp "$WASM_EXEC_PATH" ./wasm/wasm_exec.js

echo "Copied build system wasm_exec.js file to wasm/ directory."