package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
	"gopkg.in/yaml.v3"
)

func TestLsAnyMatchesUnionOfFieldAndTagWalks(t *testing.T) {
	t.Parallel()
	dir, store := newStore(t)
	fields := func(keys ...string) map[string]*yaml.Node {
		out := make(map[string]*yaml.Node, len(keys))
		for _, key := range keys {
			value := "present"
			tag := "!!str"
			if key == "due" {
				value = "2026-01-01T00:00:00Z"
				tag = "!!timestamp"
			}
			out[key] = &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value}
		}
		return out
	}
	for _, fiber := range []*felt.Felt{
		{ID: "shuttle-only", Name: "Shuttle", Status: felt.StatusActive, CreatedAt: mustParseTime(t, "2026-01-01T00:00:00Z"), ExtraFields: fields("shuttle")},
		{ID: "due-only", Name: "Due", Status: felt.StatusOpen, CreatedAt: mustParseTime(t, "2026-01-02T00:00:00Z"), ExtraFields: fields("due")},
		{ID: "cycle-only", Name: "Cycle", Status: felt.StatusClosed, Tags: []string{"cycle"}, CreatedAt: mustParseTime(t, "2026-01-03T00:00:00Z")},
		{ID: "overlap", Name: "Overlap", Status: felt.StatusActive, Tags: []string{"cycle"}, CreatedAt: mustParseTime(t, "2026-01-04T00:00:00Z"), ExtraFields: fields("shuttle", "due")},
		{ID: "none", Name: "None", Status: felt.StatusActive, CreatedAt: mustParseTime(t, "2026-01-05T00:00:00Z")},
	} {
		if err := store.Write(fiber); err != nil {
			t.Fatal(err)
		}
	}
	projection := "id,name,status,tags,due,shuttle"
	oldRows := map[string][]byte{}
	var oldOrder []string
	for _, filter := range [][]string{{"--has-field", "shuttle"}, {"--has-field", "due"}, {"-t", "cycle"}} {
		args := append([]string{"ls", "--json"}, filter...)
		args = append(args, "--json-field", projection)
		out, err := runCommand(t, dir, args...)
		if err != nil {
			t.Fatalf("old filter %v: %v\n%s", filter, err, out)
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(out), &rows); err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			var id string
			_ = json.Unmarshal(row["id"], &id)
			encoded, _ := json.Marshal(row)
			if _, seen := oldRows[id]; !seen {
				oldOrder = append(oldOrder, id)
			}
			oldRows[id] = encoded
		}
	}
	want := oldRows
	// Compare by id because the old union's order is defined by its first-seen walk order.
	rowsFor := func(args ...string) map[string][]byte {
		out, err := runCommand(t, dir, append([]string{"ls", "--json"}, args...)...)
		if err != nil {
			t.Fatalf("ls %v: %v\n%s", args, err, out)
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(out), &rows); err != nil {
			t.Fatal(err)
		}
		byID := make(map[string][]byte, len(rows))
		var order []string
		for _, row := range rows {
			var id string
			_ = json.Unmarshal(row["id"], &id)
			var decoded any
			encodedRow, _ := json.Marshal(row)
			_ = json.Unmarshal(encodedRow, &decoded)
			byID[id], _ = json.Marshal(decoded)
			order = append(order, id)
		}
		if len(args) > 0 && args[0] == "--any" && !slices.Contains(args, "--ids-from") && !reflect.DeepEqual(order, oldOrder) {
			t.Fatalf("--any order = %v, want legacy union order %v", order, oldOrder)
		}
		return byID
	}
	anyArgs := []string{"--any", "field:shuttle", "--any", "field:due", "--any", "tag:cycle", "--json-field", projection}
	if got := rowsFor(anyArgs...); !reflect.DeepEqual(got, want) {
		t.Fatalf("--any rows differ from legacy union: got=%v want=%v", got, want)
	}
	idsPath := filepath.Join(t.TempDir(), "ids")
	if err := os.WriteFile(idsPath, []byte("shuttle-only\ndue-only\ncycle-only\noverlap\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	anyIDs := append(append([]string{}, anyArgs...), "--ids-from", idsPath)
	full := rowsFor(anyArgs...)
	hot := rowsFor(anyIDs...)
	if !reflect.DeepEqual(hot, full) {
		t.Fatalf("--any with --ids-from differs: got=%v want=%v", hot, full)
	}
}
