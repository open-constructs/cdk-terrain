# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

FROM public.ecr.aws/jsii/superchain:1-bookworm-slim-node22@sha256:0287511d177cee98efeabea9f1ad26442d17c755716a8395e1110e07e0554fbf

# Links the GHCR package to this repository so it shows up under the repo's
# Packages and inherits repo-based access settings.
LABEL org.opencontainers.image.source="https://github.com/open-constructs/cdk-terrain" \
      org.opencontainers.image.description="jsii/superchain with Terraform toolchain for CDK Terrain CI and development" \
      org.opencontainers.image.licenses="MPL-2.0"

USER root

ARG DEFAULT_TERRAFORM_VERSION
ARG AVAILABLE_TERRAFORM_VERSIONS
ARG DEFAULT_OPENTOFU_VERSION
ARG AVAILABLE_OPENTOFU_VERSIONS

RUN apt-get update -y && apt-get install -y unzip jq build-essential time python3-venv wget

RUN python3 -m pip install --break-system-packages pipx "pip>=23.3.1" pipenv
RUN ln -s /usr/bin/python3 /usr/bin/python

RUN npm install -g @sentry/cli@2.58.4 --unsafe-perm
# From the official gradle Dockerfile (https://github.com/keeganwitt/docker-gradle/blob/2ba84220e311de7a55f3731509dd772a885b86f8/jdk8/Dockerfile)
ENV GRADLE_HOME=/opt/gradle
ENV GRADLE_VERSION=8.2.1
ARG GRADLE_DOWNLOAD_SHA256=03ec176d388f2aa99defcadc3ac6adf8dd2bce5145a129659537c0874dea5ad1
RUN set -o errexit -o nounset \
    && echo "Downloading Gradle" \
    && wget --no-verbose --output-document=gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
    \
    && echo "Checking download hash" \
    && echo "${GRADLE_DOWNLOAD_SHA256} *gradle.zip" | sha256sum --check - \
    \
    && echo "Installing Gradle" \
    && unzip gradle.zip \
    && rm gradle.zip \
    && mv "gradle-${GRADLE_VERSION}" "${GRADLE_HOME}/" \
    && ln --symbolic "${GRADLE_HOME}/bin/gradle" /usr/bin/gradle \
    \
    && echo "Testing Gradle installation" \
    && gradle --version

ENV TF_PLUGIN_CACHE_DIR="/root/.terraform.d/plugin-cache"           \
    # MAVEN_OPTS is set in jsii/superchain with -Xmx512m. This isn't enough memory for provider generation.
    MAVEN_OPTS="-Xms256m -Xmx3G"

# Create the plugin cache dir. Terraform and OpenTofu both warn on every
# invocation when TF_PLUGIN_CACHE_DIR points at a directory that does not
# exist, which pollutes stderr for anything parsing their output.
RUN mkdir -p "${TF_PLUGIN_CACHE_DIR}"

# Install Terraform. `set -eu` is load-bearing: Docker runs each RUN under
# `/bin/sh -c` without it, and a `for` loop reports the status of the last
# command in its body, so without it a failed download or checksum would be
# masked by the trailing cleanup and the layer would be recorded as built.
RUN set -eu; \
    for VERSION in ${AVAILABLE_TERRAFORM_VERSIONS}; do \
      RELEASE="https://releases.hashicorp.com/terraform/${VERSION}"; \
      curl -fsSLO "${RELEASE}/terraform_${VERSION}_linux_amd64.zip"; \
      curl -fsSLO "${RELEASE}/terraform_${VERSION}_SHA256SUMS"; \
      grep "  terraform_${VERSION}_linux_amd64.zip$" "terraform_${VERSION}_SHA256SUMS" | sha256sum --check -; \
      mkdir -p "/usr/local/bin/tf/versions/${VERSION}"; \
      unzip "terraform_${VERSION}_linux_amd64.zip" -d "/usr/local/bin/tf/versions/${VERSION}"; \
      ln -s "/usr/local/bin/tf/versions/${VERSION}/terraform" "/usr/local/bin/terraform${VERSION}"; \
      rm "terraform_${VERSION}_linux_amd64.zip" "terraform_${VERSION}_SHA256SUMS"; \
    done; \
    ln -s "/usr/local/bin/tf/versions/${DEFAULT_TERRAFORM_VERSION}/terraform" /usr/local/bin/terraform

# Install OpenTofu, laid out the same way as Terraform above: one `tofu<version>`
# binary per available version so TERRAFORM_BINARY_NAME can select one per job,
# plus a bare `tofu` pointing at the default.
RUN set -eu; \
    for VERSION in ${AVAILABLE_OPENTOFU_VERSIONS}; do \
      RELEASE="https://github.com/opentofu/opentofu/releases/download/v${VERSION}"; \
      curl -fsSLO "${RELEASE}/tofu_${VERSION}_linux_amd64.zip"; \
      curl -fsSLO "${RELEASE}/tofu_${VERSION}_SHA256SUMS"; \
      grep "  tofu_${VERSION}_linux_amd64.zip$" "tofu_${VERSION}_SHA256SUMS" | sha256sum --check -; \
      mkdir -p "/usr/local/bin/otf/versions/${VERSION}"; \
      unzip "tofu_${VERSION}_linux_amd64.zip" -d "/usr/local/bin/otf/versions/${VERSION}"; \
      ln -s "/usr/local/bin/otf/versions/${VERSION}/tofu" "/usr/local/bin/tofu${VERSION}"; \
      rm "tofu_${VERSION}_linux_amd64.zip" "tofu_${VERSION}_SHA256SUMS"; \
    done; \
    ln -s "/usr/local/bin/otf/versions/${DEFAULT_OPENTOFU_VERSION}/tofu" /usr/local/bin/tofu

# Fail the build unless every declared binary exists and reports the version it
# is named for. Guards against a silently skipped install and against the bare
# `terraform`/`tofu` symlinks dangling when their default never got installed.
RUN set -eu; \
    for VERSION in ${AVAILABLE_TERRAFORM_VERSIONS}; do \
      "terraform${VERSION}" version | head -1 | grep -qF "v${VERSION}"; \
    done; \
    for VERSION in ${AVAILABLE_OPENTOFU_VERSIONS}; do \
      "tofu${VERSION}" version | head -1 | grep -qF "v${VERSION}"; \
    done; \
    terraform version | head -1 | grep -qF "v${DEFAULT_TERRAFORM_VERSION}"; \
    tofu version | head -1 | grep -qF "v${DEFAULT_OPENTOFU_VERSION}"; \
    echo "verified terraform: ${AVAILABLE_TERRAFORM_VERSIONS} (default ${DEFAULT_TERRAFORM_VERSION})"; \
    echo "verified opentofu:  ${AVAILABLE_OPENTOFU_VERSIONS} (default ${DEFAULT_OPENTOFU_VERSION})"
