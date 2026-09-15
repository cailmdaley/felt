#!/usr/bin/env bash
# el8-toolchain.sh — install the build/test/upload dependencies the EL8 daemon
# legs need, inside an almalinux:8 container.
#
# Split from build-otp-el8.sh because the two are needed at different times: the
# release job needs this toolchain on EVERY run (to compile NIFs, run the boot
# test, read ELF symbol tables, upload the tarball), while the OTP build runs
# only on a cache miss.
#
# Assumes it is running as root in the container, which is how GitHub Actions
# runs `container:` jobs.

set -euo pipefail

dnf -y install \
  gcc gcc-c++ make autoconf \
  ncurses-devel openssl-devel zlib-devel \
  git curl tar gzip xz unzip which binutils \
  tmux jq procps-ng findutils perl
dnf clean all

echo "EL8 toolchain installed: $(gcc --version | head -1)"
