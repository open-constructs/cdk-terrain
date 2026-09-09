#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

set -euo pipefail

# stub for the `docker` executable. it is used as CDK_DOCKER when executing unit
# tests in `staging.test.ts` It outputs the command line to
# `/tmp/docker-stub.input` and accepts one of several commands that impact its
# behavior.

# Output goes to $DOCKER_STUB_DIR so parallel jest workers cannot clobber each
# other's recorded invocations.
stub_dir="${DOCKER_STUB_DIR:-/tmp}"
echo "$@" >> "${stub_dir}/docker-stub.input.concat"
echo "$@" > "${stub_dir}/docker-stub.input"

if echo "$@" | grep "DOCKER_STUB_SUCCESS_NO_OUTPUT"; then
  exit 0
fi

if echo "$@" | grep "DOCKER_STUB_FAIL"; then
  echo "A HUGE FAILING DOCKER STUFF"
  exit 1
fi

if echo "$@" | grep "DOCKER_STUB_SUCCESS"; then
  outdir=$(echo "$@" | xargs -n1 | grep "/asset-output" | head -n1 | cut -d":" -f1)
  touch ${outdir}/test.txt
  exit 0
fi

if echo "$@" | grep "DOCKER_STUB_MULTIPLE_FILES"; then
  outdir=$(echo "$@" | xargs -n1 | grep "/asset-output" | head -n1 | cut -d":" -f1)
  touch ${outdir}/test1.txt
  touch ${outdir}/test2.txt
  exit 0
fi

if echo "$@" | grep "DOCKER_STUB_SINGLE_ARCHIVE"; then
  outdir=$(echo "$@" | xargs -n1 | grep "/asset-output" | head -n1 | cut -d":" -f1)
  touch ${outdir}/test.zip
  exit 0
fi

if echo "$@" | grep "DOCKER_STUB_SINGLE_FILE_WITHOUT_EXT"; then
  outdir=$(echo "$@" | xargs -n1 | grep "/asset-output" | head -n1 | cut -d":" -f1)
  touch ${outdir}/test # create a file without extension
  exit 0
fi

if echo "$@" | grep "DOCKER_STUB_SINGLE_FILE"; then
  outdir=$(echo "$@" | xargs -n1 | grep "/asset-output" | head -n1 | cut -d":" -f1)
  touch ${outdir}/test.txt
  exit 0
fi

echo "Docker mock only supports one of the following commands: DOCKER_STUB_SUCCESS_NO_OUTPUT,DOCKER_STUB_FAIL,DOCKER_STUB_SUCCESS,DOCKER_STUB_MULTIPLE_FILES,DOCKER_STUB_SINGLE_ARCHIVE,DOCKER_STUB_SINGLE_FILE,DOCKER_STUB_SINGLE_FILE_WITHOUT_EXT, got '$@'"
exit 1
