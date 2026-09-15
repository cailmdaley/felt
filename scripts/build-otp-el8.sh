#!/usr/bin/env bash
# build-otp-el8.sh — build Erlang/OTP from source into /opt/otp inside an
# almalinux:8 container.
#
# Why from source: erlef/setup-beam has no EL8 prebuilt, and EL8 is the floor we
# need. A Mix release bundles ERTS, so the shipped beam.smp inherits the symbol
# versions of whatever compiled it; built on ubuntu-latest it demands GLIBC_2.38
# and no RHEL/Rocky/Alma 8 cluster can load it. Building here pins the artifact
# to glibc 2.28 and the gcc-8 toolchain.
#
# Called by BOTH workflows so they produce a byte-identical cache entry:
#   - .github/workflows/ci.yml       warms the cache on pushes to main
#   - .github/workflows/release.yml  builds on a cache miss at tag time
# Keeping it in one script is what makes the two cache keys interchangeable.
#
# Versions come from .github/el8-toolchain.env; the caller may also export
# EL8_OTP_VERSION directly. Expects scripts/el8-toolchain.sh to have run.
#
# Usage:  bash scripts/build-otp-el8.sh  [install-prefix]   (default /opt/otp)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${1:-/opt/otp}"

# Explicit export wins; otherwise take the pin from the shared env file.
if [ -z "${EL8_OTP_VERSION:-}" ]; then
  # shellcheck disable=SC1091  # path is computed, resolved at runtime
  . "${repo_root}/.github/el8-toolchain.env"
fi
: "${EL8_OTP_VERSION:?EL8_OTP_VERSION is not set and .github/el8-toolchain.env did not define it}"

echo "Building OTP ${EL8_OTP_VERSION} into ${prefix}"

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
cd "$build_dir"

curl -fsSL -o otp_src.tar.gz \
  "https://github.com/erlang/otp/releases/download/OTP-${EL8_OTP_VERSION}/otp_src_${EL8_OTP_VERSION}.tar.gz"
tar xzf otp_src.tar.gz
cd "otp_src_${EL8_OTP_VERSION}"
export ERL_TOP="$PWD"

# crypto and ssl are kept — the daemon's HTTP stack needs them. The GUI, Java
# and ODBC apps are dead weight in a headless release and only add build
# dependencies. Dropping wx does NOT make the build C++-free: the BEAM JIT is
# C++, so beam.smp still links libstdc++. Measured on EL8 this lands at
# GLIBCXX_3.4.21 / GCC_4.2.0, well under the floors the gate enforces.
./configure --prefix="${prefix}" \
  --without-javac --without-wx --without-odbc \
  --without-debugger --without-observer --without-et
make -j"$(nproc)"
make install

# A silent crypto failure would surface only as a daemon that cannot serve
# HTTPS, long after this job went green. Assert the NIF actually loads.
"${prefix}/bin/erl" -noshell \
  -eval 'io:format("OTP ~s, crypto ok~n", [erlang:system_info(otp_release)]), crypto:start(), halt(0).'
