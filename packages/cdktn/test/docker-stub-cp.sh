#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

set -euo pipefail
# stub for the `docker` executable. it is used as CDK_DOCKER when executing unit
# tests in `staging.test.ts` This variant is specific for tests that use the
# docker copy method for files (VOLUME_COPY), instead of bind mounts.
#
# Output goes to $DOCKER_STUB_DIR so parallel jest workers cannot clobber each
# other's recorded invocations.

stub_dir="${DOCKER_STUB_DIR:-/tmp}"
echo "$@" >> "${stub_dir}/docker-stub-cp.input.concat"
echo "$@" > "${stub_dir}/docker-stub-cp.input"

# Emulate files produced by bundling. For `docker cp <container>:<src> <dest>`
# the destination is the final argument; deriving it that way keeps the stub
# independent of where the caller placed its bundling directory.
if echo "$@" | grep -q "^cp " && echo "$@" | grep -q "/asset-output"; then
  outdir="${!#}"
  if [ -d "$outdir" ]; then
    if grep -q "DOCKER_STUB_SINGLE_FILE_WITHOUT_EXT" \
      "${stub_dir}/docker-stub-cp.input.concat"; then
      touch "${outdir}/test" # create a file without extension
    else
      touch "${outdir}/test.zip"
    fi
  fi
fi

exit 0
