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
			hook := trustHook(codexPluginRef, codexPluginRef+":hooks/hooks.json:stop:0:0", "modified")
			requests := fakeCodexTrust(t, env, []codexTrustHook{hook})
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
			writes := 0
			for _, req := range requests() {
				if string(req["method"]) == `"config/batchWrite"` {
					writes++
				}
			}
			if writes != 1 {
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
