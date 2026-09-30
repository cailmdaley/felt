package shuttle

import _ "embed"

// embeddedAgentJSON is the built-in agent registry: the generic, harness-level
// set every shuttle binary ships with, compiled in so the registry needs no
// on-disk file at runtime. Account-specific additions and host restrictions
// still belong in ~/.config/shuttle/agents.json (or $SHUTTLE_AGENTS_FILE), which
// LoadAgentRegistry layers on top — see registry_config.go.
//
//go:embed agents.builtin.json
var embeddedAgentJSON []byte
