package shuttle

import _ "embed"

// embeddedAgentJSON is the built-in agent registry: the generic, harness-level
// set every felt binary ships with, compiled in so the registry needs no
// on-disk file at runtime. Account-specific additions and host restrictions
// still belong in ~/.config/felt/agents.json (or $FELT_AGENTS_FILE), which
// LoadAgentRegistry layers on top — see registry_config.go.
//
//go:embed agents.builtin.json
var embeddedAgentJSON []byte
