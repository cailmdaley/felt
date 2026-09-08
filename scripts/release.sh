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

# A release is always cut from the public main branch after it has caught up
# with origin. This prevents a stale checkout from creating a tag that the
# printed `git push origin main ...` command cannot reproduce.
if [ "$(git branch --show-current)" != "main" ]; then
    echo "ERROR: releases must be cut from the main branch" >&2
    exit 1
fi
if ! git fetch --quiet origin main --tags; then
    echo "ERROR: could not refresh origin/main and tags; refusing to release" >&2
    exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "ERROR: HEAD is not aligned with origin/main; push or integrate changes before releasing" >&2
    git rev-list --left-right --count HEAD...origin/main >&2 || true
    exit 1
fi

MANIFESTS=(
    claude-plugin/.claude-plugin/plugin.json
    claude-plugin/.codex-plugin/plugin.json
)

# Refuse if working tree is dirty (other than the manifests we're about
# to bump). Releasing on top of unrelated WIP creates muddy commits.
dirty_path=""
while IFS= read -r status_line; do
    path="${status_line:3}"
    case "$path" in
        "${MANIFESTS[0]}"|"${MANIFESTS[1]}") ;;
        *) dirty_path="$path"; break ;;
    esac
done < <(git status --porcelain=v1 --untracked-files=all)
if [ -n "$dirty_path" ]; then
    echo "ERROR: working tree has uncommitted changes outside the plugin manifests" >&2
    git status -s | head -10 >&2
    exit 1
fi

# Refuse if tag already exists.
if git rev-parse --verify --quiet "$TAG" >/dev/null; then
    echo "ERROR: tag $TAG already exists" >&2
    exit 1
fi
if ! REMOTE_TAGS="$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")"; then
    echo "ERROR: could not check whether $TAG already exists on origin" >&2
    exit 1
fi
if [ -n "$REMOTE_TAGS" ]; then
    echo "ERROR: tag $TAG already exists on origin" >&2
    exit 1
fi

# ── Docs-freshness gate ──────────────────────────────────────────────
# The docs site (docs/ + docs/mkdocs.yml) and README must not fall more than
# one release behind the code. Before tagging, an agent audits the
# release range for user-facing changes the docs don't reflect and
# reports PASS or FAIL. Requires the `claude` CLI; skip explicitly with
# SKIP_DOCS_AUDIT=1 (e.g. for a docs-only or emergency release).
if [ "${SKIP_DOCS_AUDIT:-0}" != "1" ]; then
    if ! command -v claude >/dev/null 2>&1; then
        echo "ERROR: docs audit needs the claude CLI (or set SKIP_DOCS_AUDIT=1)" >&2
        exit 1
    fi
    PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
    RANGE="${PREV_TAG:+$PREV_TAG..}HEAD"
    echo "→ Docs audit over $RANGE (claude -p, this takes a minute)…"
    VERDICT="$(claude -p --model claude-sonnet-4-5 "You are the docs-freshness gate for a felt release. Review 'git log --stat $RANGE' for user-facing changes (CLI verbs/flags, frontmatter schema, install steps, daemon behavior) and check whether docs/, docs/mkdocs.yml, and README.md reflect them. Ignore internal refactors. Reply with exactly one line: 'PASS' or 'FAIL: <the drifted claims, briefly>'.")"
    echo "$VERDICT"
    case "$VERDICT" in
        PASS*) echo "✓ Docs audit passed" ;;
        *)
            echo "ERROR: docs audit did not pass; fix the drift or rerun with SKIP_DOCS_AUDIT=1" >&2
            exit 1
            ;;
    esac
fi

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
if ! git diff --quiet HEAD -- "${MANIFESTS[@]}"; then
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
  git push origin main "$TAG"

Pushing $TAG to origin (cailmdaley/felt) triggers the goreleaser
workflow, which builds the cross-platform binaries and updates the
homebrew tap.
EOF
