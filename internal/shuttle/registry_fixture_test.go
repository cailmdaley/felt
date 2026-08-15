package shuttle

import (
	"fmt"
	"os"
)

// loadAgentRegistryFromFile reads an agents registry from the given path,
// bypassing the built-in layer entirely (a fixture is the whole registry).
// Production loading always goes through LoadAgentRegistry, which layers the
// user file onto the built-ins; this shape exists only so tests can pin axis
// and validation logic against a fixture that is the entire fleet.
func loadAgentRegistryFromFile(path string) (*AgentRegistry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	agents, err := parseAnyAgentsPayload(data, path)
	if err != nil {
		return nil, err
	}
	return &AgentRegistry{agents: agents, builtinsMode: BuiltinsMerge}, nil
}
