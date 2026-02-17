#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

# Determine which testable packages are affected by changes between BASE and HEAD.
# Outputs a JSON array suitable for GitHub Actions matrix consumption.
#
# Usage:
#   bash tools/affected-packages.sh <base_ref>
#   bash tools/affected-packages.sh origin/main
#
# Output examples:
#   ["cdktn","cdktn-cli","@cdktn/commons"]   # some packages affected
#   []                                         # nothing affected

set -euo pipefail

BASE_REF="${1:?Usage: affected-packages.sh <base_ref>}"

# The 8 packages that have unit tests
TESTABLE_PACKAGES=(
  "cdktn"
  "cdktn-cli"
  "@cdktn/hcl2cdk"
  "@cdktn/hcl2json"
  "@cdktn/provider-schema"
  "@cdktn/provider-generator"
  "@cdktn/commons"
  "@cdktn/cli-core"
)

all_packages_json() {
  printf '%s\n' "${TESTABLE_PACKAGES[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))'
}

# Fallback: return all packages on any error
fallback() {
  echo "::warning::Nx affected detection failed, falling back to all packages" >&2
  all_packages_json
  exit 0
}
trap fallback ERR

# Get affected projects from Nx
AFFECTED=$(npx nx show projects --affected --base="$BASE_REF" --head=HEAD 2>/dev/null)

if [[ -z "$AFFECTED" ]]; then
  # No projects affected at all
  echo "[]"
  exit 0
fi

# Filter to only testable packages
MATCHED=()
for pkg in "${TESTABLE_PACKAGES[@]}"; do
  if echo "$AFFECTED" | grep -qx "$pkg"; then
    MATCHED+=("$pkg")
  fi
done

if [[ ${#MATCHED[@]} -eq 0 ]]; then
  echo "[]"
else
  printf '%s\n' "${MATCHED[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))'
fi
