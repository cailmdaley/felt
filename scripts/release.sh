#!/usr/bin/env bash
# scripts/release.sh — cut a new felt release.
#
# Bumps the plugin manifests to <version>, commits the bump, creates an
# annotated tag, and prints push instructions. The plugin manifests'
# version field must track the binary version: Claude Code and Codex
# both compare versions when running `plugin update`, and won't pick up
# new content if the version field hasn't changed.
#
# Usage:
#   scripts/release.sh 1.0.9                    # default tag message
#   scripts/release.sh 1.0.9 "Release: bugfix"  # custom tag message
#
# After it runs, follow the printed push instructions to actually publish.

set -euo pipefail

if [ $# -lt 1 ]; then
    cat >&2 <<EOF
Usage: $0 <version> [<tag-message>]

Examples:
    $0 1.0.9
    $0 1.0.9 "Release v1.0.9: bug fixes"
EOF
    exit 1
fi

VERSION="$1"
TAG="v$VERSION"
TAG_MSG="${2:-Release $TAG}"

# Validate semver-ish (X.Y.Z[-prerelease]).
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]]; then
    echo "ERROR: '$VERSION' is not a valid X.Y.Z semver string" >&2
    exit 1
fi

# Run from the repo root regardless of where it was invoked from.
cd "$(git rev-parse --show-toplevel)"

# Refuse if working tree is dirty (other than the manifests we're about
# to bump). Releasing on top of unrelated WIP creates muddy commits.
if ! git diff --quiet --ignore-submodules HEAD -- ':!claude-plugin/.claude-plugin/plugin.json' ':!claude-plugin/.codex-plugin/plugin.json'; then
    echo "ERROR: working tree has uncommitted changes outside the plugin manifests" >&2
    git status -s | head -10 >&2
    exit 1
fi

# Refuse if tag already exists.
if git rev-parse --verify --quiet "$TAG" >/dev/null; then
    echo "ERROR: tag $TAG already exists" >&2
    exit 1
fi

MANIFESTS=(
    claude-plugin/.claude-plugin/plugin.json
    claude-plugin/.codex-plugin/plugin.json
)

for f in "${MANIFESTS[@]}"; do
    if [ ! -f "$f" ]; then
        echo "ERROR: missing $f" >&2
        exit 1
    fi
    if command -v jq >/dev/null 2>&1; then
        jq --arg v "$VERSION" '.version = $v' "$f" > "$f.tmp"
        mv "$f.tmp" "$f"
    else
        # Portable in-place edit (BSD/macOS + GNU): write to .tmp, then mv.
        sed -E "s/(\"version\":[[:space:]]*\")[^\"]+(\")/\1$VERSION\2/" "$f" > "$f.tmp"
        mv "$f.tmp" "$f"
    fi
    echo "✓ Bumped $f to $VERSION"
done

# Only commit if anything actually changed. Re-running for the same
# version is a no-op (e.g. the bump was already committed manually).
if ! git diff --quiet -- "${MANIFESTS[@]}"; then
    git add "${MANIFESTS[@]}"
    git commit -m "Bump plugin manifests to $VERSION"
    echo "✓ Committed version bump"
else
    echo "· Plugin manifests already at $VERSION; no commit needed"
fi

git tag -a "$TAG" -m "$TAG_MSG"
echo "✓ Created annotated tag $TAG"

cat <<EOF

Local release ready. To publish:
  git push lightcone main "$TAG"
  git push origin main "$TAG"

Pushing $TAG to origin (cailmdaley/felt) triggers the goreleaser
workflow, which builds the cross-platform binaries and updates the
homebrew tap.
EOF
