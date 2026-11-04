package feltcli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func requireRealCodex(t *testing.T, env *sysenv.Env) {
	t.Helper()
	reason := ""
	if _, err := env.LookPath("codex"); err != nil {
		reason = "codex is not installed"
	} else if version, old := testApp(t, env).codexVersionTooOld(); old {
		reason = "Codex " + version + " predates plugin content trust (requires " + codexHookTrustMinimum + ")"
	}
	if reason != "" {
		if env.Getenv("FELT_REQUIRE_REAL_CODEX") == "1" {
			t.Fatal("required real-Codex gate: " + reason)
		}
		t.Skip(reason)
	}
}

func TestRequiredRealCodexCannotSkip(t *testing.T) {
	if mode := os.Getenv("FELT_TEST_CODEX_GATE_CHILD"); mode != "" {
		env, _ := testEnv(t)
		env.Set("FELT_REQUIRE_REAL_CODEX", "1")
		env.Set("PATH", t.TempDir())
		if mode == "old" {
			fakeCommand(t, env, "codex", "#!/bin/sh\necho codex-cli 0.164.0\n")
		}
		requireRealCodex(t, env)
		return
	}
	for _, mode := range []string{"absent", "old"} {
		t.Run(mode, func(t *testing.T) {
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(binary, "-test.run=^TestRequiredRealCodexCannotSkip$")
			cmd.Env = append(os.Environ(), "FELT_TEST_CODEX_GATE_CHILD="+mode)
			out, err := cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "required real-Codex gate:") {
				t.Fatalf("required Codex was skipped instead of failing: %v\n%s", err, out)
			}
		})
	}
}

func TestLinuxAndCIRequirePinnedRealCodex(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"scripts/test-linux.sh", ".github/workflows/ci.yml"} {
		data, err := os.ReadFile(filepath.Join(repoRoot(t), name))
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"install-test-codex.sh", "FELT_REQUIRE_REAL_CODEX"} {
			if !strings.Contains(string(data), want) {
				t.Errorf("%s does not enforce %s", name, want)
			}
		}
	}
}

func assertPrivateCodexSkills(t *testing.T, a *app, cwd string) {
	t.Helper()
	rpc, err := a.openCodexTrustRPC()
	if err != nil {
		t.Fatal(err)
	}
	defer rpc.close()
	var result struct {
		Data []struct {
			Skills []struct {
				Name    string `json:"name"`
				Path    string `json:"path"`
				Enabled bool   `json:"enabled"`
			} `json:"skills"`
			Errors []any `json:"errors"`
		} `json:"data"`
	}
	if err := rpc.call("skills/list", map[string]any{"cwds": []string{cwd}, "forceReload": true}, &result); err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{"felt-skills:felt": false, "felt-skills:shuttle": false}
	for _, entry := range result.Data {
		if len(entry.Errors) > 0 {
			t.Fatalf("skills discovery errors: %+v", entry.Errors)
		}
		for _, skill := range entry.Skills {
			if _, ok := wanted[skill.Name]; ok {
				if !skill.Enabled {
					t.Fatalf("disabled skill: %+v", skill)
				}
				if _, err := os.ReadFile(skill.Path); err != nil {
					t.Fatalf("unreadable skill: %+v: %v", skill, err)
				}
				wanted[skill.Name] = true
			}
		}
	}
	for name, found := range wanted {
		if !found {
			t.Fatalf("skills/list did not load %s: %+v", name, result)
		}
	}
}
