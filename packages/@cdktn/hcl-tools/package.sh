#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

set -euo pipefail
bundle=$(pnpm pack | tail -n 1)
rm -fr dist
mkdir -p dist/js
mv ${bundle} dist/js
