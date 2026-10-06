package shuttle

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
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
