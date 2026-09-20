package cmd

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClaudePluginMaintenanceEnvironmentIsChildOnly(t *testing.T) {
	for _, key := range []string{"CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER"} {
		t.Setenv(key, "0")
	}
	args := []string{"marketplace", "add", "/path with spaces/plugin"}
	command := claudePluginCommand(args...)
	if want := append([]string{"claude", "plugin"}, args...); !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("arguments changed: got %q, want %q", command.Args, want)
	}
	for _, key := range []string{"CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER"} {
		count := 0
		for _, entry := range command.Env {
			if strings.HasPrefix(entry, key+"=") {
				count++
				if entry != key+"=1" {
					t.Fatalf("unguarded child environment: %q", entry)
				}
			}
		}
		if count != 1 || os.Getenv(key) != "0" {
			t.Fatalf("%s child entries=%d, parent=%q", key, count, os.Getenv(key))
		}
	}
}

func TestHarnessRunnerScopesBareModeToClaudePluginCommands(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	t.Setenv("FAKE_MAINTENANCE_LOG", log)
	t.Setenv("CLAUDE_CODE_SIMPLE", "0")
	t.Setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "0")
	t.Setenv("DISABLE_AUTOUPDATER", "0")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	script := `#!/bin/sh
printf '%s|%s|%s|%s\n' "$*" "$CLAUDE_CODE_SIMPLE" "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" "$DISABLE_AUTOUPDATER" >> "$FAKE_MAINTENANCE_LOG"
`
	for _, bin := range []string{"claude", "codex"} {
		if err := os.WriteFile(filepath.Join(dir, bin), []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, call := range [][]string{{"claude", "plugin", "list", "--json"}, {"claude", "--version"}, {"codex", "plugin", "list"}} {
		if err := runHarnessCLI(call[0], call[1:]...); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	want := "plugin list --json|1|1|1\n--version|0|0|0\nplugin list|0|0|0\n"
	if string(got) != want {
		t.Fatalf("child environment scope: got %q, want %q", got, want)
	}
}
