package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestShuttleHostJSON_ReportsTheResolvedDataDir: the shells that write the
// stop marker read data_dir rather than expanding SHUTTLE_DATA_DIR themselves,
// so it carries the trim and leading-~ rule.
func TestShuttleHostJSON_ReportsTheResolvedDataDir(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	home := t.TempDir()
	setHostEnvIn(t, env, filepath.Join(t.TempDir(), "absent.json"), nil, map[string]string{
		"SHUTTLE_DATA_DIR": "  ~/state/shuttle \n",
		"SHUTTLE_HOST":     "fixture-host",
	})
	env.Set("HOME", home)
	out, _, err := executeIn(t, env, t.TempDir(), "host", "--json")
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
	t.Parallel()
	env := testEnv(t)
	dataDir := filepath.Join(t.TempDir(), "a&b<c>")
	setHostEnvIn(t, env, filepath.Join(t.TempDir(), "absent.json"), nil, map[string]string{
		"SHUTTLE_DATA_DIR": dataDir,
		"SHUTTLE_HOST":     "fixture-host",
	})
	out, _, err := executeIn(t, env, t.TempDir(), "host", "--json")
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
	t.Parallel()
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
