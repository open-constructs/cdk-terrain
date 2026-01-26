#!/bin/bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0


set -ex

sed -i 's/"io\.cdktn:cdktn:0\.0\.0"/files("..\/..\/..\/dist\/java\/io\/cdktn\/cdktn\/0.0.0\/cdktn-0.0.0.jar")/g' build.gradle