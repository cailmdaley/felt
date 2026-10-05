package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestStatePathFixtureParity runs the per-file override cases the daemon's
// Shuttle.state_path/2 is also held to, so SHUTTLE_EVENTS_FILE and its
// siblings name one file for the hook that writes it and the daemon that
// reads it.
func TestStatePathFixtureParity(t *testing.T) {
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
	t.Setenv("SHUTTLE_DATA_DIR", sf.DataDir)
	for _, file := range sf.Files {
		for _, c := range sf.Cases {
			t.Run(file.EnvVar+"/"+c.Name, func(t *testing.T) {
				if c.Env == nil {
					t.Setenv(file.EnvVar, "")
					os.Unsetenv(file.EnvVar)
				} else {
					t.Setenv(file.EnvVar, *c.Env)
				}
				want := strings.NewReplacer("<data_dir>", sf.DataDir, "<leaf>", file.Leaf).Replace(c.Expect)
				got, explicit := testApp(t).shuttleStatePath(file.EnvVar, file.Leaf)
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

// TestShuttleHostJSON_ReportsTheResolvedDataDir: the shells that write the
// stop marker read data_dir rather than expanding SHUTTLE_DATA_DIR themselves,
// so it carries the trim and leading-~ rule.
func TestShuttleHostJSON_ReportsTheResolvedDataDir(t *testing.T) {
	home := t.TempDir()
	setHostEnv(t, filepath.Join(t.TempDir(), "absent.json"), nil, map[string]string{
		"SHUTTLE_DATA_DIR": "  ~/state/shuttle \n",
		"SHUTTLE_HOST":     "fixture-host",
	})
	t.Setenv("HOME", home)
	out, err := runCommand(t, t.TempDir(), "host", "--json")
	if err != nil {
		t.Fatalf("host --json: %v\n%s", err, out)
	}
	var got struct {
		DataDir string `json:"data_dir"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decoding %q: %v", out, err)
	}
	if want := home + "/state/shuttle"; got.DataDir != want {
		t.Fatalf("data_dir = %q, want %q", got.DataDir, want)
	}
}

// TestShuttleHostJSON_PrintsAmpersandPathsVerbatim: the shells pull data_dir
// out with sed, not a JSON decoder, so '&' must not come out as &.
func TestShuttleHostJSON_PrintsAmpersandPathsVerbatim(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "a&b<c>")
	setHostEnv(t, filepath.Join(t.TempDir(), "absent.json"), nil, map[string]string{
		"SHUTTLE_DATA_DIR": dataDir,
		"SHUTTLE_HOST":     "fixture-host",
	})
	out, err := runCommand(t, t.TempDir(), "host", "--json")
	if err != nil {
		t.Fatalf("host --json: %v\n%s", err, out)
	}
	if want := `"data_dir": "` + dataDir + `"`; !strings.Contains(out, want) {
		t.Fatalf("output lacks %s verbatim:\n%s", want, out)
	}
	var got struct {
		DataDir string `json:"data_dir"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decoding %q: %v", out, err)
	}
	if got.DataDir != dataDir {
		t.Fatalf("data_dir = %q, want %q", got.DataDir, dataDir)
	}
}

// TestStopMarkerWriters: shell launchers that touch the marker resolve its
// directory through shuttle; none expands SHUTTLE_DATA_DIR on its own.
func TestStopMarkerWriters(t *testing.T) {
	for _, file := range []string{"../../bin/shuttle-launch", "../../bin/shuttle-deploy"} {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, raw := range []string{`touch "${SHUTTLE_DATA_DIR`, `touch "$${SHUTTLE_DATA_DIR`} {
			if strings.Contains(text, raw) {
				t.Errorf("%s touches the stop marker under the unresolved SHUTTLE_DATA_DIR", file)
			}
		}
		if strings.Contains(text, "heartbeat.stopped") && !strings.Contains(text, `"data_dir"`) && !strings.Contains(text, "stop_marker") {
			t.Errorf("%s writes the stop marker without shuttle's data_dir", file)
		}
	}
}
