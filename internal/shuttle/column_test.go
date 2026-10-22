package shuttle

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

// The cases the board and the daemon's roster are held to.
const columnCases = "../../daemon/test/fixtures/columns/cases.json"

func TestColumnMatchesTheSharedCases(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile(columnCases)
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string         `json:"name"`
		Live   bool           `json:"live"`
		Column string         `json:"column"`
		Fiber  map[string]any `json:"fiber"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range cases {
		front := map[string]any{"name": c.Name}
		for k, v := range c.Fiber {
			front[k] = v
		}
		text, err := yaml.Marshal(front)
		if err != nil {
			t.Fatal(err)
		}
		f, err := felt.Parse("hub/thread", []byte("---\n"+string(text)+"---\n"))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		block, ok, err := BlockOf(f)
		if err != nil || !ok {
			t.Fatalf("%s: block %v %v", c.Name, ok, err)
		}
		if got := Column(f, block, c.Live, time.Now()); got != c.Column {
			t.Errorf("%s: column %q, want %q", c.Name, got, c.Column)
		}
	}
}
