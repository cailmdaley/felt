package feltcli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv/sysenvtest"
)

func TestClaudePluginMaintenanceEnvironmentIsChildOnly(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	for _, key := range []string{"CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER"} {
		env.Set(key, "0")
	}
	args := []string{"marketplace", "add", "/path with spaces/plugin"}
	command := testApp(t, env).claudePluginCommand(args...)
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
		if count != 1 || env.Getenv(key) != "0" {
			t.Fatalf("%s child entries=%d, parent=%q", key, count, env.Getenv(key))
		}
	}
}

func TestHarnessRunnerScopesBareModeToClaudePluginCommands(t *testing.T) {
	t.Parallel()
	env, _ := testEnv(t)
	log := filepath.Join(t.TempDir(), "calls")
	env.Set("FAKE_MAINTENANCE_LOG", log)
	env.Set("CLAUDE_CODE_SIMPLE", "0")
	env.Set("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "0")
	env.Set("DISABLE_AUTOUPDATER", "0")
	script := `printf '%s|%s|%s|%s\n' "$*" "$CLAUDE_CODE_SIMPLE" "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" "$DISABLE_AUTOUPDATER" >> "$FAKE_MAINTENANCE_LOG"
`
	for _, bin := range []string{"claude", "codex"} {
		sysenvtest.FakeCommand(t, env, bin, script)
	}
	a := testApp(t, env)
	for _, call := range [][]string{{"claude", "plugin", "list", "--json"}, {"claude", "--version"}, {"codex", "plugin", "list"}} {
		if err := a.runHarnessCLI(call[0], call[1:]...); err != nil {
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
