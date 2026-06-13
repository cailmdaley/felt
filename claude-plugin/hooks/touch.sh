#!/bin/bash
# PostToolUse hook for the felt plugin.
#
# Thin shim: the binary owns the logic. `felt hook posttool` reads the
# PostToolUse payload from stdin and, when an Edit/Write/MultiEdit touched a
# fiber file, stamps that fiber's git-durable recency anchor (frontmatter
# updated-at). This is what makes direct Edit-tool body edits count toward
# recency without felt's read commands ever writing files. See
# `felt hook posttool --help`.
#
# `felt update` and brew's post-install refresh both binary and plugin
# together, so this script always runs against a matching binary.

set -e
exec felt hook posttool
