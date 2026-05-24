#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

#
# usage: align-version.sh [SUFFIX]
#
# aligns lerna version to package.json
# this is executed in CI builds so artifacts include the actual version instead of 0.0.0
#
# if SUFFIX is provided, appends this to the version as-is
#

set -euo pipefail
scriptdir="$(cd $(dirname $0) && pwd)"
cd ${scriptdir}/..

suffix="${1:-}"
version="$(node -p "require('./package.json').version")${suffix}"
npx lerna version ${version} --yes --exact --force-publish=* --no-git-tag-version --no-push

# `lerna version` does not rewrite peerDependencies, so rewrite any "0.0.0"
# entries here to the aligned version.
while IFS= read -r pkg; do
  jq --arg v "${version}" '
    if .peerDependencies then
      .peerDependencies |= with_entries(
        if .value == "0.0.0" then .value = $v else . end
      )
    else . end
  ' "${pkg}" > "${pkg}.tmp" && mv "${pkg}.tmp" "${pkg}"
done < <(git ls-files 'packages/*/package.json' 'packages/@*/*/package.json')
