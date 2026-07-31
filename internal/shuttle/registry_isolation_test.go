package shuttle

import (
	"os"
	"path/filepath"
)

// LoadAgentRegistry reads the operator's ~/.config/felt/agents.json. Point
// $FELT_AGENTS_FILE at a path that cannot exist, so the suite always sees the
// built-in layer alone and a developer's own registry can never turn a green
// run red (or a red one green). Tests that want a user layer set the variable
// themselves with t.Setenv.
func init() {
	os.Setenv("FELT_AGENTS_FILE", filepath.Join(os.TempDir(), "felt-tests-no-such-agents.json"))
}
