package feltcli

import "testing"

func TestFeltRootDoesNotExposeShuttleCompatibilityCommand(t *testing.T) {
	command, _, err := rootCmd.Find([]string{"shuttle"})
	if err == nil && command != rootCmd {
		t.Fatalf("felt exposes a Shuttle compatibility command: %q", command.CommandPath())
	}
}
