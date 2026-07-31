package shuttle

import _ "embed"

// embeddedAgentJSON is the built-in agent registry: the generic, harness-level
// set every felt binary ships with (claude/codex/human), compiled in so the
// registry needs no on-disk file at runtime.
//
// It is a floor, not a fleet. Account-specific model tiers and wrappers belong
// in the user registry (~/.config/felt/agents.json or $FELT_AGENTS_FILE), which
// LoadAgentRegistry layers on top — see registry_config.go, and
// share/agents.example.json for a fuller worked example.
//
//go:embed agents.builtin.json
var embeddedAgentJSON []byte
