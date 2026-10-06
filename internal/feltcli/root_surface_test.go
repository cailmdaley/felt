package feltcli

import (
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestFeltRootDoesNotExposeShuttleCompatibilityCommand(t *testing.T) {
	t.Parallel()
	rootCmd := NewRootCmd(sysenv.New(t.TempDir(), nil))
	command, _, err := rootCmd.Find([]string{"shuttle"})
	if err == nil && command != rootCmd {
		t.Fatalf("felt exposes a Shuttle compatibility command: %q", command.CommandPath())
	}
}
