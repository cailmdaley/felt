package shuttle

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

// TestDataDirFixtureParity runs the cases the daemon's Shuttle.data_dir/0 is
// also held to, so a ~-prefixed or padded SHUTTLE_DATA_DIR names one directory
// for every file either side keeps.
func TestDataDirFixtureParity(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	data, err := os.ReadFile("../../daemon/test/fixtures/data_dir/cases.json")
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	var fixture struct {
		Cases []struct {
			Name   string  `json:"name"`
			Env    *string `json:"env"`
			Expect string  `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parsing fixture: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("fixture has no cases")
	}

	home := t.TempDir()
	env.Set("HOME", home)
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if c.Env == nil {
				env.Unset("SHUTTLE_DATA_DIR")
			} else {
				env.Set("SHUTTLE_DATA_DIR", *c.Env)
			}
			want := c.Expect
			if want == "~" || strings.HasPrefix(want, "~/") {
				want = home + want[1:]
			}
			got, err := DataDir(env)
			if err != nil || got != want {
				t.Fatalf("SHUTTLE_DATA_DIR=%v: got %q err %v, want %q", c.Env, got, err, want)
			}
		})
	}
}

// TestStatePathFixtureParity runs the per-file override cases the daemon's
// Shuttle.state_path/2 is also held to, so SHUTTLE_EVENTS_FILE and its
// siblings name one file for every process that writes or reads it.
func TestStatePathFixtureParity(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile("../../daemon/test/fixtures/data_dir/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		StateFiles struct {
			DataDir string `json:"data_dir"`
			Files   []struct {
				EnvVar string `json:"env_var"`
				Leaf   string `json:"leaf"`
			} `json:"files"`
			Cases []struct {
				Name   string  `json:"name"`
				Env    *string `json:"env"`
				Expect string  `json:"expect"`
			} `json:"cases"`
		} `json:"state_files"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	sf := fixture.StateFiles
	if len(sf.Files) == 0 || len(sf.Cases) == 0 {
		t.Fatal("fixture has no state_files cases")
	}
	resolvers := map[string]func(*sysenv.Env) (string, bool){
		"SHUTTLE_EVENTS_FILE":   EventsFile,
		"SHUTTLE_SESSIONS_FILE": SessionsFile,
		"SHUTTLE_COMMITS_FILE":  CommitsFile,
	}
	for _, file := range sf.Files {
		resolve := resolvers[file.EnvVar]
		if resolve == nil {
			t.Fatalf("no resolver for %s", file.EnvVar)
		}
		for _, c := range sf.Cases {
			t.Run(file.EnvVar+"/"+c.Name, func(t *testing.T) {
				t.Parallel()
				env := testEnv(t)
				env.Set("SHUTTLE_DATA_DIR", sf.DataDir)
				if c.Env == nil {
					env.Unset(file.EnvVar)
				} else {
					env.Set(file.EnvVar, *c.Env)
				}
				want := strings.NewReplacer("<data_dir>", sf.DataDir, "<leaf>", file.Leaf).Replace(c.Expect)
				got, explicit := resolve(env)
				if got != want {
					t.Fatalf("%s=%v: got %q, want %q", file.EnvVar, c.Env, got, want)
				}
				if wantExplicit := !strings.HasPrefix(c.Expect, "<data_dir>"); explicit != wantExplicit {
					t.Fatalf("explicit = %v, want %v", explicit, wantExplicit)
				}
			})
		}
	}
}
