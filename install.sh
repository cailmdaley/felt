#!/bin/sh
# install.sh — install the felt CLI (and optionally the Shuttle daemon).
#
#   FELT_REPO         source repo (default cailmdaley/felt)
#   FELT_INSTALL_DIR  where the felt binary lands
#   FELT_VERSION      install this exact tag instead of the latest release
#   SHUTTLE=1         also install the Shuttle daemon
#   SHUTTLE_HOME      where the daemon lands (default ~/.local/share/shuttle)
set -eu

REPO="${FELT_REPO:-cailmdaley/felt}"

# FELT_INSTALL_DIR, else /usr/local/bin when writable, else ~/.local/bin (no sudo needed).
if [ -n "${FELT_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$FELT_INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) ARCHIVE_OS="Darwin" ;;
  Linux)  ARCHIVE_OS="Linux" ;;
  *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64)  ARCHIVE_ARCH="x86_64" ;;
  aarch64) ARCHIVE_ARCH="arm64" ;;
  arm64)   ARCHIVE_ARCH="arm64" ;;
  *)       echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Resolve the tag to install.
#
# FELT_VERSION pins an exact tag and skips the releases/latest lookup
# entirely. That lookup returns only the newest non-prerelease release, so
# pinning is the ONLY way to install a release candidate — by design: an RC
# must never reach someone who just ran the install line. Both `1.1.0-rc.1`
# and `v1.1.0-rc.1` are accepted; the tag itself carries the `v`.
if [ -n "${FELT_VERSION:-}" ]; then
  case "$FELT_VERSION" in
    v*) TAG="$FELT_VERSION" ;;
    *)  TAG="v${FELT_VERSION}" ;;
  esac
  echo "FELT_VERSION is set: installing pinned release ${TAG} (not the latest)."
else
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"
  if [ -z "$TAG" ]; then
    echo "Failed to fetch latest release of ${REPO}" >&2
    exit 1
  fi
fi

# Fetch one release asset, or fail naming the tag and asset that were missing.
# Pinned installs land here most often — a typo'd or unpublished tag is the
# expected failure — so the message has to say which tag it tried rather than
# leaving a bare "curl: (22)" or a tar EOF error.
download_asset() {
  _url="https://github.com/${REPO}/releases/download/${TAG}/$1"
  if ! curl -fsSL "$_url" -o "$2"; then
    echo "Failed to download $1 for ${TAG}." >&2
    echo "  ${_url}" >&2
    echo "Check that the tag exists and publishes that asset:" >&2
    echo "  https://github.com/${REPO}/releases/tag/${TAG}" >&2
    exit 1
  fi
}

echo "Installing felt ${TAG} (${OS}/${ARCH})..."

# Download and extract
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

download_asset "felt_${ARCHIVE_OS}_${ARCHIVE_ARCH}.tar.gz" "$TMPDIR/felt.tar.gz"
tar xzf "$TMPDIR/felt.tar.gz" -C "$TMPDIR"

# Install
mkdir -p "$INSTALL_DIR"
mv "$TMPDIR/felt" "$INSTALL_DIR/felt"

echo "felt ${TAG} installed to ${INSTALL_DIR}/felt"

# Check PATH
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to your PATH:  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac

# ── Shuttle daemon (opt-in) ────────────────────────────────────────────────
# SHUTTLE=1 also installs the Shuttle daemon: an ERTS-bundled Mix release
# fetched from the same GitHub release — no Erlang, Elixir, or Node needed.
# It lands in $SHUTTLE_HOME (default ~/.local/share/shuttle); the daemon's
# front door is $SHUTTLE_HOME/bin/shuttle. Runtime prerequisites: tmux + felt.
if [ "${SHUTTLE:-0}" = "1" ]; then
  SHUTTLE_HOME="${SHUTTLE_HOME:-${HOME}/.local/share/shuttle}"

  echo "Installing Shuttle daemon ${TAG} to ${SHUTTLE_HOME}..."
  download_asset "shuttle_${ARCHIVE_OS}_${ARCHIVE_ARCH}.tar.gz" "$TMPDIR/shuttle.tar.gz"
  tar xzf "$TMPDIR/shuttle.tar.gz" -C "$TMPDIR"
  rm -rf "$SHUTTLE_HOME"
  mkdir -p "$(dirname "$SHUTTLE_HOME")"
  mv "$TMPDIR/shuttle" "$SHUTTLE_HOME"

  echo "Shuttle daemon ${TAG} installed."
  echo "  Start it:   FELT_STORES=<your-store> ${SHUTTLE_HOME}/bin/shuttle start"
  echo "  Keep-alive: see https://cailmdaley.github.io/felt/shuttle/installation/"
fi

# Wire up agent plugins for any detected agent CLI. The plugins are core
# to how felt feels — SessionStart and PreToolUse hooks surface active
# fibers at session start and gate non-felt tool use until the felt skill
# activates; a PostToolUse hook stamps updated-at when the agent edits a
# fiber file directly; and an activity-event hook records harness events
# for Shuttle, writing nothing unless ~/.shuttle exists. They're how
# fibers stay visible across sessions without you needing to mention them.
# Setup commands are idempotent (re-running them refreshes registration)
# and the install can be cleanly reversed via `felt uninstall`.
if command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1; then
  echo
  echo "Wiring up felt's agent plugins:"
  echo "  • Claude Code: marketplace + plugin + SessionStart / PreToolUse / PostToolUse hooks,"
  echo "                 plus an activity-event hook that writes nothing unless ~/.shuttle exists"
  echo "  • Codex:       marketplace + plugin (Codex asks you to trust the hooks on first run)"
  echo "To remove later: felt uninstall"
  echo
fi
if command -v claude >/dev/null 2>&1; then
  echo "Setting up Claude Code plugin..."
  "${INSTALL_DIR}/felt" setup claude || \
    echo "  (Claude setup failed; run 'felt setup claude' manually)"
fi
if command -v codex >/dev/null 2>&1; then
  echo
  echo "Setting up Codex plugin..."
  "${INSTALL_DIR}/felt" setup codex || \
    echo "  (Codex setup failed; run 'felt setup codex' manually)"
fi
