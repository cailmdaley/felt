package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// remoteFixture is one row of test/fixtures/remotes/expected.json — the shared
// expectation the Elixir suite asserts against too.
type remoteFixture struct {
	Name             string `json:"name"`
	URL              string `json:"url"`
	SSH              string `json:"ssh"`
	Display          string `json:"display"`
	Port             int    `json:"port"`
	RemotePort       int    `json:"remote_port"`
	PollIntervalMS   int    `json:"poll_interval_ms"`
	RequestTimeoutMS int    `json:"request_timeout_ms"`
	StaleMultiplier  int    `json:"stale_multiplier"`
	Label            string `json:"label"`
}

type remoteFixtureDoc struct {
	LaunchdLabelPrefix string          `json:"launchd_label_prefix"`
	Remotes            []remoteFixture `json:"remotes"`
}

const remotesFixtureDir = "../test/fixtures/remotes"

// TestRemotesFixtureParity is the anti-drift device: the Go reader and the
// Elixir reader (test/shuttle/remotes_test.exs) read the SAME fixture files and
// assert the SAME expected.json. A default that changes in one language fails in
// both. FELT_STORES parity is guarded only by comments; this one is executable.
func TestRemotesFixtureParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(remotesFixtureDir, "expected.json"))
	if err != nil {
		t.Fatalf("read expected.json: %v", err)
	}
	var expected map[string]json.RawMessage
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatalf("parse expected.json: %v", err)
	}

	cases := 0
	for fixture, blob := range expected {
		if fixture == "_comment" {
			continue
		}
		cases++
		fixture, blob := fixture, blob
		t.Run(fixture, func(t *testing.T) {
			var want remoteFixtureDoc
			if err := json.Unmarshal(blob, &want); err != nil {
				t.Fatalf("parse expectation: %v", err)
			}
			t.Setenv("FELT_REMOTES_FILE", filepath.Join(remotesFixtureDir, fixture))

			doc, err := loadRemotesFile()
			if err != nil {
				t.Fatalf("loadRemotesFile: %v", err)
			}
			if doc.LaunchdLabelPrefix != want.LaunchdLabelPrefix {
				t.Errorf("launchd_label_prefix = %q, want %q", doc.LaunchdLabelPrefix, want.LaunchdLabelPrefix)
			}
			if len(doc.Remotes) != len(want.Remotes) {
				t.Fatalf("got %d remotes, want %d", len(doc.Remotes), len(want.Remotes))
			}
			for i, w := range want.Remotes {
				got := doc.Remotes[i]
				g := remoteFixture{
					Name:             got.Name,
					URL:              got.URL,
					SSH:              got.SSH,
					Display:          got.Display,
					Port:             got.Port,
					RemotePort:       got.RemotePort,
					PollIntervalMS:   got.PollIntervalMS,
					RequestTimeoutMS: got.RequestTimeoutMS,
					StaleMultiplier:  got.StaleMultiplier,
					Label:            got.label(doc.LaunchdLabelPrefix),
				}
				if g != w {
					t.Errorf("remote #%d:\n got  %+v\n want %+v", i, g, w)
				}
			}
		})
	}
	if cases == 0 {
		t.Fatal("expected.json listed no fixtures")
	}
}

// TestConfiguredRemotes_Resolution locks the precedence and the absent-file
// contract. There is deliberately no compact FELT_REMOTES env form, so
// FELT_REMOTES_FILE is the only override.
func TestConfiguredRemotes_Resolution(t *testing.T) {
	dir := t.TempDir()

	// Missing file → empty, no error. A host with no fleet is a valid host.
	t.Setenv("FELT_REMOTES_FILE", filepath.Join(dir, "absent.json"))
	got, err := configuredRemotes()
	if err != nil {
		t.Fatalf("missing file should not error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("missing file → %v, want none", got)
	}

	// Malformed → error naming the path. The CLI is the fleet's validator.
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte(`{"remotes": [`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", bad)
	if _, err := configuredRemotes(); err == nil {
		t.Fatal("malformed file should error")
	} else if !strings.Contains(err.Error(), bad) {
		t.Fatalf("error should name the path, got %q", err)
	}

	// FELT_REMOTES_FILE points the reader elsewhere.
	good := filepath.Join(dir, "good.json")
	if err := os.WriteFile(good, []byte(`{"version":1,"remotes":[{"name":"x","port":4009}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", good)
	got, err = configuredRemotes()
	if err != nil {
		t.Fatalf("configuredRemotes: %v", err)
	}
	if len(got) != 1 || got[0].Name != "x" || got[0].URL != "http://127.0.0.1:4009" {
		t.Fatalf("got %+v", got)
	}
}

// TestConfiguredRemotes_DropsDisabled — an entry can stay on file without being
// polled or tunnelled.
func TestConfiguredRemotes_DropsDisabled(t *testing.T) {
	writeRemotes(t, `{"version":1,"remotes":[
	  {"name":"on","port":4001},
	  {"name":"off","port":4002,"enabled":false}
	]}`)

	got, err := configuredRemotes()
	if err != nil {
		t.Fatalf("configuredRemotes: %v", err)
	}
	if len(got) != 1 || got[0].Name != "on" {
		t.Fatalf("got %+v, want only the enabled remote", got)
	}
}

func TestNormalizeRemotes_Validation(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"empty name", `[{"name":"","port":4001}]`, "name is required"},
		{"duplicate name", `[{"name":"a","port":4001},{"name":"a","port":4002}]`, "duplicate remote name"},
		{"duplicate port", `[{"name":"a","port":4001},{"name":"b","port":4001}]`, "already used by"},
		{"port too high", `[{"name":"a","port":70000}]`, "out of range"},
		{"port negative", `[{"name":"a","port":-1}]`, "out of range"},
		{"no port, no url", `[{"name":"a"}]`, "needs a port or an explicit url"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writeRemotes(t, tc.body)
			_, err := loadRemotesFile()
			if err == nil {
				t.Fatalf("want error containing %q, got none", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

// TestSaveRemotes_RoundTrip — atomic write, and an empty fleet deletes the file
// (matching the stores/projects writers).
func TestSaveRemotes_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "remotes.json")
	t.Setenv("FELT_REMOTES_FILE", path)

	doc := remotesFile{Remotes: []remoteSpec{{Name: "a", Port: 4001}}}
	if err := saveRemotes(doc); err != nil {
		t.Fatalf("saveRemotes: %v", err)
	}
	reloaded, err := loadRemotesFile()
	if err != nil {
		t.Fatalf("loadRemotesFile: %v", err)
	}
	if len(reloaded.Remotes) != 1 || reloaded.Remotes[0].Name != "a" {
		t.Fatalf("round trip lost the entry: %+v", reloaded)
	}
	if reloaded.Version != 1 {
		t.Errorf("version = %d, want 1", reloaded.Version)
	}

	if err := saveRemotes(remotesFile{}); err != nil {
		t.Fatalf("saveRemotes(empty): %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("empty save should delete the file, stat err = %v", err)
	}
}

// writeRemotes points FELT_REMOTES_FILE at a temp file holding body.
func writeRemotes(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "remotes.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FELT_REMOTES_FILE", path)
	return path
}
