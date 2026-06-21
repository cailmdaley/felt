package shuttle

import _ "embed"

// embeddedAgentJSON is the canonical agent registry (share/agents.json in the
// Shuttle repo, vendored here as the single source of truth for both felt and
// the daemon). Compiled into the binary so the registry needs no on-disk file
// at runtime.
//
//go:embed agents.json
var embeddedAgentJSON []byte
