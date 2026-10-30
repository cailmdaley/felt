package feltcli

import (
	"strings"
	"testing"
)

// Negative control: remove refreshCodexHookTrust from either native install
// path; that path no longer emits config/batchWrite and the test fails.
func TestCodexNativeInstallAndRestoreRecordHookTrust(t *testing.T) {
	for _, operation := range []string{"install", "restore", "trust-only"} {
		t.Run(operation, func(t *testing.T) {
			t.Parallel()
			env, _ := testEnv(t)
			f := fakeCodexTrust(t, env, []codexTrustHook{feltHook("stop", "modified")})
			a := testApp(t, env)
			source := t.TempDir()
			var err error
			switch operation {
			case "install":
				err = a.installCodexPluginAtSource(source)
			case "restore":
				err = a.restoreCodexInstallation(codexInstallationState{Configured: true, Installed: true, Source: source})
			case "trust-only":
				_, _, err = executeIn(t, env, source, "setup", "codex", "--trust-hooks")
			}
			if err != nil {
				t.Fatal(err)
			}
			if writes := countMethod(f.requests(t), "config/batchWrite"); writes != 1 {
				t.Fatalf("%s wrote trust %d times, want 1", operation, writes)
			}
		})
	}
}

func TestCodexTrustOnlyFlagRejectsInstallOptions(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"--uninstall"}, {"--source", "/example"}} {
		env, _ := testEnv(t)
		_, _, err := executeIn(t, env, t.TempDir(), append([]string{"setup", "codex", "--trust-hooks"}, args...)...)
		if err == nil || !strings.Contains(err.Error(), "trust-hooks") {
			t.Fatalf("conflicting flags accepted: %v", err)
		}
	}
}
