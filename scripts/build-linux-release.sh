#!/usr/bin/env bash
# build-linux-release.sh <tree> <out> — build what a Linux x86_64 host runs,
# on a Mac, for bin/shuttle-deploy to ship.
#
#   <out>/felt, <out>/shuttle   the CLIs, cross-compiled static (CGO_ENABLED=0)
#   <out>/rel.tar.gz            the daemon release with its own ERTS and the
#                               board bundle from <tree>/ui/dist in priv/
#
# The release is assembled in an almalinux:8 container (linux/amd64), so its
# native code needs glibc 2.28 at most, and its OTP links a static OpenSSL, so
# the crypto NIF needs no libcrypto from the host. The builder image is built
# once per toolchain recipe and cached by the container runtime; Mix's deps,
# build and Hex caches persist under ${XDG_CACHE_HOME:-~/.cache}/felt-linux-release.
#
# <tree> must be a Git worktree whose HEAD is the revision to build and whose
# ui/dist holds its board bundle. SHUTTLE_VERSION and GOFLAGS, when set, stamp
# the release and the CLIs as `make build` would.
#
# The container runs amd64 under emulation, where the BEAM JIT's dual-mapped
# code pages crash; ERL_FLAGS="+JMsingle true" in the image maps them once.
# It is the builder's environment only, not the shipped release's.
#
# Runtime: Apple's `container` CLI when installed, else `docker`.

set -euo pipefail

tree=$(cd "${1:?usage: $0 <tree> <out>}" && pwd -P)
out=${2:?usage: $0 <tree> <out>}
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
here=$(cd "$(dirname "$0")" && pwd -P)

[ -f "$tree/ui/dist/index.html" ] || { echo "build-linux-release: $tree/ui/dist has no bundle" >&2; exit 1; }

if command -v container >/dev/null 2>&1; then
  # Apple's default container (4 CPUs, 1 GiB) is too small for mix release.
  runtime=container platform=(--arch amd64) limits=(--cpus 8 --memory 8g)
  container system status >/dev/null 2>&1 || container system start >/dev/null
elif command -v docker >/dev/null 2>&1; then
  runtime=docker platform=(--platform linux/amd64) limits=()
else
  echo "build-linux-release: needs Apple's container CLI or docker" >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$here/../.github/el8-toolchain.env"

dockerfile=$(cat <<EOF
FROM ${EL8_IMAGE}
COPY el8-toolchain.sh build-otp-el8.sh /tmp/
RUN bash /tmp/el8-toolchain.sh && dnf -y install perl-IPC-Cmd perl-Time-Piece && dnf clean all
RUN cd /tmp && curl -fsSL https://github.com/openssl/openssl/releases/download/openssl-${EL8_OPENSSL_VERSION}/openssl-${EL8_OPENSSL_VERSION}.tar.gz | tar xz \\
 && cd openssl-${EL8_OPENSSL_VERSION} && ./Configure linux-x86_64 no-shared no-tests no-docs -fPIC --prefix=/opt/openssl --libdir=lib \\
 && make -j"\$(nproc)" && make install_sw && cd /tmp && rm -rf openssl-${EL8_OPENSSL_VERSION}
ENV EL8_OTP_VERSION=${EL8_OTP_VERSION} ERL_FLAGS="+JMsingle true" OTP_CONFIGURE_FLAGS="--with-ssl=/opt/openssl --disable-dynamic-ssl-lib"
RUN bash /tmp/build-otp-el8.sh /opt/otp
RUN curl -fsSL -o /tmp/elixir.zip https://github.com/elixir-lang/elixir/releases/download/v${EL8_ELIXIR_VERSION}/elixir-otp-${EL8_OTP_VERSION%%.*}.zip \\
 && unzip -q /tmp/elixir.zip -d /opt/elixir && rm /tmp/elixir.zip
ENV PATH=/opt/otp/bin:/opt/elixir/bin:\$PATH LANG=C.UTF-8 MIX_HOME=/opt/mix
RUN mix local.hex --force && mix local.rebar --force && git config --system safe.directory '*'
EOF
)
recipe=$(printf '%s\n' "$dockerfile" | cat - "$here/el8-toolchain.sh" "$here/build-otp-el8.sh" | cksum | awk '{print $1}')
image="shuttle-linux-build:otp${EL8_OTP_VERSION}-${recipe}"

if ! "$runtime" image inspect "$image" >/dev/null 2>&1; then
  # OpenSSL and OTP compile under amd64 emulation: tens of minutes on Apple's
  # default 2-CPU builder (`container builder start --cpus 8 --memory 8g`).
  echo "build-linux-release: building $image (once per toolchain recipe)" >&2
  printf '%s\n' "$dockerfile" | "$runtime" build "${platform[@]}" -t "$image" -f - "$here" >&2
fi

echo "build-linux-release: CLIs (linux/amd64)" >&2
for cli in felt shuttle; do
  (cd "$tree" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$out/$cli" "./cmd/$cli")
done

# Git resolves the worktree's HEAD through its common directory, so both are
# mounted at their own paths.
common=$(git -C "$tree" rev-parse --git-common-dir)
case "$common" in /*) ;; *) common="$tree/$common" ;; esac
common=$(cd "$common" && pwd -P)
cache="${XDG_CACHE_HOME:-$HOME/.cache}/felt-linux-release"
mkdir -p "$cache"
rm -rf "$out/rel" "$out/rel.tar.gz"

echo "build-linux-release: daemon release in $image" >&2
"$runtime" run --rm "${platform[@]}" ${limits[@]+"${limits[@]}"} \
  -v "$tree:$tree" -v "$common:$common" -v "$out:/out" -v "$cache:/cache" \
  -e MIX_ENV=prod -e MIX_DEPS_PATH=/cache/deps -e MIX_BUILD_ROOT=/cache/_build -e HEX_HOME=/cache/hex \
  -e SHUTTLE_VERSION="${SHUTTLE_VERSION:-}" -e COMMIT="$(git -C "$tree" rev-parse HEAD)" -w "$tree/daemon" "$image" bash -euc '
    [ -n "$SHUTTLE_VERSION" ] || unset SHUTTLE_VERSION
    mix deps.get
    mix shuttle.gen_version
    grep -q "\"$COMMIT\"" lib/shuttle/build_info.ex || { echo "build_info.ex does not name $COMMIT" >&2; exit 1; }
    mix compile
    mix compile.app --force
    mix release shuttled --path /out/rel --overwrite
    for app in /out/rel/lib/shuttle-*; do mkdir -p "$app/priv/ui" && cp -R ../ui/dist "$app/priv/ui/"; done
    /out/rel/bin/shuttled eval "32 = byte_size(:crypto.hash(:sha256, \"x\"))"
    bash ../scripts/check-glibc-floor.sh /out/rel
    tar -C /out/rel -czf /out/rel.tar.gz .
    rm -rf /out/rel
    echo "build-linux-release: container CPU time (user, system; shell then children):" >&2
    times >&2
  '
ls -l "$out" >&2
