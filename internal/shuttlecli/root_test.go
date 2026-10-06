package shuttlecli

import (
	"strings"
	"testing"
)

func TestShuttleRootSurfaceIsTopLevel(t *testing.T) {
	t.Parallel()
	rootCmd := NewRootCmd(testEnv(t))
	if rootCmd.Use != "shuttle" {
		t.Fatalf("root Use = %q, want shuttle", rootCmd.Use)
	}
	for _, name := range []string{"status", "install", "remotes", "doctor", "ls", "show", "check"} {
		command, _, err := rootCmd.Find([]string{name})
		if err != nil || command == rootCmd {
			t.Errorf("%q is not a top-level Shuttle command: command=%v err=%v", name, command, err)
		}
	}
	for _, name := range []string{"shuttle", "add", "edit", "find"} {
		command, _, err := rootCmd.Find([]string{name})
		if err == nil && command != rootCmd {
			t.Errorf("%q should not be a command in Shuttle: %q", name, command.CommandPath())
		}
	}
	for _, name := range []string{"store", "json"} {
		if rootCmd.PersistentFlags().Lookup(name) == nil {
			t.Errorf("Shuttle root is missing --%s", name)
		}
	}
	if rootCmd.PersistentFlags().Lookup("directory") != nil {
		t.Fatal("Shuttle root exposes Felt's --directory selector")
	}
}

func TestShuttleRootHelpNamesItsStoreFlag(t *testing.T) {
	t.Parallel()
	help := NewRootCmd(testEnv(t)).UsageString()
	if !strings.Contains(help, "--store") || !strings.Contains(help, "--json") {
		t.Fatalf("Shuttle help omits shared root flags:\n%s", help)
	}
	if strings.Contains(help, "felt ls") || strings.Contains(help, "felt add") {
		t.Fatalf("Shuttle help describes Felt commands:\n%s", help)
	}
}
