#!/bin/sh
set -eu

REPO="${FELT_REPO:-cailmdaley/felt}"

# Default: ~/.local/bin (no sudo needed). Override with FELT_INSTALL_DIR.
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

# Get latest release tag
TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"
if [ -z "$TAG" ]; then
  echo "Failed to fetch latest release" >&2
  exit 1
fi

ASSET="felt_${ARCHIVE_OS}_${ARCHIVE_ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

echo "Installing felt ${TAG} (${OS}/${ARCH})..."

# Download and extract
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsSL "$URL" | tar xz -C "$TMPDIR"

# Install
mkdir -p "$INSTALL_DIR"
mv "$TMPDIR/felt" "$INSTALL_DIR/felt"

echo "felt ${TAG} installed to ${INSTALL_DIR}/felt"

# Check PATH
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to your PATH:  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac

# Wire up agent plugins for any detected agent CLI. The plugins are core
# to how felt feels — SessionStart and PreToolUse hooks surface active
# fibers at session start and gate non-felt tool use until the felt skill
# activates. They're how fibers stay visible across sessions without you
# needing to mention them. Setup commands are idempotent (re-running them
# refreshes registration) and the install can be cleanly reversed via
# `felt uninstall`.
if command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1; then
  echo
  echo "Wiring up felt's agent plugins:"
  echo "  • Claude Code: marketplace + plugin + SessionStart/PreToolUse hooks"
  echo "  • Codex:       marketplace + plugin + features.plugin_hooks=true"
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
