package cmd

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestStatePathFixtureParity runs the per-file override cases the daemon's
// Shuttle.state_path/2 is also held to, so SHUTTLE_EVENTS_FILE and its
// siblings name one file for the hook that writes it and the daemon that
// reads it.
func TestStatePathFixtureParity(t *testing.T) {
	data, err := os.ReadFile("../daemon/test/fixtures/data_dir/cases.json")
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
				got, explicit := shuttleStatePath(file.EnvVar, file.Leaf)
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
	out, err := runCommand(t, t.TempDir(), "shuttle", "host", "--json")
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

// scriptFunction extracts `name() { ... }` from the shell script at path.
func scriptFunction(t *testing.T, path, name string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return shellFunction(t, string(data), name)
}

// TestStopMarkerShells: bin/shuttle and bin/shuttle-deploy put the stop
// marker where felt reports the data directory, and fall back to the plain
// expansion only when felt cannot say.
func TestStopMarkerShells(t *testing.T) {
	reported := filepath.Join(t.TempDir(), "reported")
	stub := t.TempDir()
	felt := "#!/bin/sh\n[ \"$*\" = 'shuttle host --json' ] || exit 2\n" +
		"printf '{\\n  \"listen\": \"tcp://127.0.0.1:4000\",\\n  \"data_dir\": \"%s\"\\n}\\n' \"$REPORTED\"\n"
	if err := os.WriteFile(filepath.Join(stub, "felt"), []byte(felt), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REPORTED", reported)
	t.Setenv("SHUTTLE_DATA_DIR", "/plain/expansion")
	withFelt := stub + string(os.PathListSeparator) + os.Getenv("PATH")
	// No felt anywhere on this PATH: only the shell's own utilities.
	withoutFelt := t.TempDir()
	for _, tool := range []string{"sh", "sed", "head", "printf"} {
		if path, err := exec.LookPath(tool); err == nil {
			_ = os.Symlink(path, filepath.Join(withoutFelt, tool))
		}
	}

	marker := scriptFunction(t, "../bin/shuttle", "stop_marker")
	prelude := scriptFunction(t, "../bin/shuttle-deploy", "listen_prelude")
	deploy, err := exec.Command("bash", "-c", prelude+"\nlisten_prelude").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, script string
	}{
		{"bin/shuttle stop_marker", marker + "\nstop_marker"},
		{"bin/shuttle-deploy daemon_kill prelude", string(deploy) + `printf '%s/heartbeat.stopped\n' "${dd:-${SHUTTLE_DATA_DIR:-$HOME/.shuttle}}"`},
	} {
		for _, path := range []struct {
			name, value, want string
		}{
			{"felt reports", withFelt, reported + "/heartbeat.stopped"},
			{"no felt", withoutFelt, "/plain/expansion/heartbeat.stopped"},
		} {
			t.Run(tc.name+"/"+path.name, func(t *testing.T) {
				cmd := exec.Command("/bin/sh", "-c", tc.script)
				cmd.Env = append(os.Environ(), "PATH="+path.value)
				out, err := cmd.Output()
				if err != nil {
					t.Fatalf("%v", err)
				}
				if got := strings.TrimSpace(string(out)); got != path.want {
					t.Fatalf("marker = %q, want %q", got, path.want)
				}
			})
		}
	}
}

// TestStopMarkerWriters: every shell that touches the stop marker resolves
// its directory through felt; none expands SHUTTLE_DATA_DIR on its own.
func TestStopMarkerWriters(t *testing.T) {
	for _, file := range []string{"../bin/shuttle", "../bin/shuttle-launch", "../bin/shuttle-deploy", "../Makefile"} {
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
			t.Errorf("%s writes the stop marker without felt's data_dir", file)
		}
	}
}
