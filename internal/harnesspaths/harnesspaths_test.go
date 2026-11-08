package harnesspaths

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// TestRootsFixtureParity runs the cases the daemon's Shuttle.HarnessPaths is
// also held to, so a transcript the daemon finds is one felt's hooks and the
// transcript index recognize, and the other way round.
func TestRootsFixtureParity(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../daemon/test/fixtures/harness_paths/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name   string            `json:"name"`
			Env    map[string]string `json:"env"`
			Expect map[string]string `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}
	roots := map[string]func(*sysenv.Env) (string, error){"claude": ClaudeProjects, "codex": CodexSessions, "pi": PiSessions}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			home := filepath.Join(dir, "home")
			environ := []string{"HOME=" + home}
			for key, value := range c.Env {
				environ = append(environ, key+"="+value)
			}
			env := sysenv.New(dir, environ)
			for harness, want := range c.Expect {
				if strings.HasPrefix(want, "~/") {
					want = home + want[1:]
				}
				got, err := roots[harness](env)
				if err != nil || got != want {
					t.Fatalf("%s: got %q err %v, want %q", harness, got, err, want)
				}
				if name := Harness(env, filepath.Join(got, "x", "session.jsonl")); name != harness {
					t.Fatalf("a transcript under %s reads as %q, want %q", got, name, harness)
				}
			}
		})
	}
}

func TestHarnessOfAPathUnderNoRoot(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	env := sysenv.New(dir, []string{"HOME=" + filepath.Join(dir, "home")})
	for _, path := range []string{"", "/elsewhere/session.jsonl", filepath.Join(dir, "home", ".claude", "projects")} {
		if name := Harness(env, path); name != "" {
			t.Fatalf("%q reads as %q", path, name)
		}
	}
}
