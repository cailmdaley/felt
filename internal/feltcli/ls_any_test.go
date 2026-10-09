package feltcli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
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
		{ID: "overlap", Name: "Overlap", Status: felt.StatusActive, Tags: []string{"cycle"}, CreatedAt: mustParseTime(t, "2026-01-01T00:00:00Z"), ExtraFields: fields("shuttle", "due")},
		{ID: "none", Name: "None", Status: felt.StatusActive, CreatedAt: mustParseTime(t, "2026-01-05T00:00:00Z")},
	} {
		if err := store.Write(fiber); err != nil {
			t.Fatal(err)
		}
	}
	projection := "id,created_at,name,status,tags,due,shuttle"
	oldRows := map[string][]byte{}
	var oldTimestampOrder []string
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
			var id, createdAt string
			_ = json.Unmarshal(row["id"], &id)
			_ = json.Unmarshal(row["created_at"], &createdAt)
			encoded, _ := json.Marshal(row)
			if _, seen := oldRows[id]; !seen &&
				(len(oldTimestampOrder) == 0 || oldTimestampOrder[len(oldTimestampOrder)-1] != createdAt) {
				oldTimestampOrder = append(oldTimestampOrder, createdAt)
			}
			oldRows[id] = encoded
		}
	}
	want := oldRows
	// Compare row sets and distinct-timestamp order. sort.Slice did not define
	// tie order for equal or missing CreatedAt values, so that is not legacy API.
	rowsFor := func(args ...string) (map[string][]byte, []string, []string) {
		out, err := runCommand(t, dir, append([]string{"ls", "--json"}, args...)...)
		if err != nil {
			t.Fatalf("ls %v: %v\n%s", args, err, out)
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(out), &rows); err != nil {
			t.Fatal(err)
		}
		byID := make(map[string][]byte, len(rows))
		var ids, timestamps []string
		for _, row := range rows {
			var id, createdAt string
			_ = json.Unmarshal(row["id"], &id)
			_ = json.Unmarshal(row["created_at"], &createdAt)
			encodedRow, _ := json.Marshal(row)
			byID[id] = encodedRow
			ids = append(ids, id)
			if len(timestamps) == 0 || timestamps[len(timestamps)-1] != createdAt {
				timestamps = append(timestamps, createdAt)
			}
		}
		return byID, ids, timestamps
	}
	anyArgs := []string{"--any", "field:shuttle", "--any", "field:due", "--any", "tag:cycle", "--json-field", projection}
	got, firstIDs, gotTimestampOrder := rowsFor(anyArgs...)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("--any rows differ from legacy union: got=%v want=%v", got, want)
	}
	if !reflect.DeepEqual(gotTimestampOrder, oldTimestampOrder) {
		t.Fatalf("--any distinct-timestamp order = %v, want %v", gotTimestampOrder, oldTimestampOrder)
	}
	for run := 0; run < 5; run++ {
		_, ids, _ := rowsFor(anyArgs...)
		if !reflect.DeepEqual(ids, firstIDs) {
			t.Fatalf("--any order changed across runs: first=%v run %d=%v", firstIDs, run, ids)
		}
	}
	idsPath := filepath.Join(t.TempDir(), "ids")
	if err := os.WriteFile(idsPath, []byte("shuttle-only\ndue-only\ncycle-only\noverlap\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	anyIDs := append(append([]string{}, anyArgs...), "--ids-from", idsPath)
	full, _, _ := rowsFor(anyArgs...)
	hot, _, _ := rowsFor(anyIDs...)
	if !reflect.DeepEqual(hot, full) {
		t.Fatalf("--any with --ids-from differs: got=%v want=%v", hot, full)
	}
}
