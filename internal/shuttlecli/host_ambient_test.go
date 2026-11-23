package shuttlecli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHostAmbientSetKeepsOtherKeysAndReportsItsSource(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	file := filepath.Join(t.TempDir(), "host.json")
	setHostEnvIn(t, env, file, nil, map[string]string{"SHUTTLE_HOST": "fixture-host", "SHUTTLE_AMBIENT": ""})
	if err := os.WriteFile(file, []byte(`{"class":"exposed","listen":"unix:///srv/x.sock","pages":{"enabled":true}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	status := func() (got struct {
		Ambient bool   `json:"ambient"`
		Source  string `json:"ambient_source"`
	}) {
		t.Helper()
		for _, args := range [][]string{{"host", "ambient", "--json"}, {"host", "--json"}} {
			prior := got
			out, _, err := executeIn(t, env, "", args...)
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			if args[1] != "ambient" && got != prior {
				t.Fatalf("host %+v disagrees with host ambient %+v", got, prior)
			}
		}
		return got
	}
	if got := status(); got.Ambient || got.Source != "default" {
		t.Fatalf("unset: %+v", got)
	}
	for _, want := range []string{"on", "off"} {
		if _, _, err := executeIn(t, env, "", "host", "ambient", want); err != nil {
			t.Fatal(err)
		}
		if got := status(); got.Ambient != (want == "on") || got.Source != "file" {
			t.Fatalf("%s: %+v", want, got)
		}
		out, _, err := executeIn(t, env, "", "host")
		if err != nil || !strings.Contains(out, "ambient "+want+" ("+file+")") {
			t.Fatalf("host text: %v\n%s", err, out)
		}
	}
	var doc map[string]any
	raw, _ := os.ReadFile(file)
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["class"] != "exposed" || doc["listen"] != "unix:///srv/x.sock" || doc["pages"] == nil || doc["ambient"] != false {
		t.Fatalf("host file = %s", raw)
	}

	env.Set("SHUTTLE_AMBIENT", "0")
	_, stderr, err := executeIn(t, env, "", "host", "ambient", "on")
	if err != nil || !strings.Contains(stderr, "$SHUTTLE_AMBIENT") {
		t.Fatalf("no override warning: %v %q", err, stderr)
	}
	if got := status(); got.Ambient || got.Source != "SHUTTLE_AMBIENT" {
		t.Fatalf("override: %+v", got)
	}

	if _, _, err := executeIn(t, env, "", "host", "ambient", "maybe"); err == nil {
		t.Fatal("accepted a value that is neither on nor off")
	}
	if err := os.WriteFile(file, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := executeIn(t, env, "", "host", "ambient", "on"); err == nil {
		t.Fatal("rewrote a malformed host file")
	}
	if raw, _ := os.ReadFile(file); string(raw) != "{nope" {
		t.Fatalf("malformed file rewritten: %s", raw)
	}
}
