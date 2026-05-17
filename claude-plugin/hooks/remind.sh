#!/bin/bash
# PreToolUse hook for the felt plugin.
#
# Thin shim: the binary owns the gate. `felt hook pretool` reads the
# PreToolUse payload from stdin and emits either a deny envelope (felt
# skill not yet activated in a felt-enabled project) or nothing (pass
# through). See `felt hook pretool --help` for the full rule set.
#
# `felt update` and brew's post-install refresh both binary and plugin
# together, so this script always runs against a matching binary.

set -e
exec felt hook pretool
