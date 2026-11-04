package shuttlecli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScanChangesFramesHeaderAndOpaqueIndex(t *testing.T) {
	dir, _ := newStore(t)
	if err := os.MkdirAll(filepath.Join(dir, ".felt", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}

	run := func(previous string) (string, string, error) {
		env := testEnv(t)
		env.Stdin = strings.NewReader(previous)
		var out, errout bytes.Buffer
		env.Stdout, env.Stderr = &out, &errout
		a := newApp(env)
		root := a.rootCmd()
		a.dir = dir
		root.SetArgs([]string{"scan-changes"})
		err := root.Execute()
		return out.String(), errout.String(), err
	}

	first, stderr, err := run("{}")
	if err != nil {
		t.Fatalf("scan-changes: %v (%s)", err, stderr)
	}
	header, index, ok := strings.Cut(first, "\n")
	if !ok {
		t.Fatalf("scan-changes output has no frame separator: %q", first)
	}
	var metadata struct {
		IDs          []string `json:"ids"`
		IndexedPaths int      `json:"indexed_paths"`
	}
	if err := json.Unmarshal([]byte(header), &metadata); err != nil {
		t.Fatalf("decode scan header %q: %v", header, err)
	}
	if metadata.IndexedPaths == 0 {
		t.Fatal("scan header reports an empty metadata index")
	}
	var parsed map[string][4]int64
	if err := json.Unmarshal([]byte(index), &parsed); err != nil {
		t.Fatalf("metadata frame is not valid index JSON: %v", err)
	}
	if metadata.IndexedPaths != len(parsed) {
		t.Fatalf("header reports %d paths for %d index entries", metadata.IndexedPaths, len(parsed))
	}

	second, stderr, err := run(index)
	if err != nil {
		t.Fatalf("scan-changes with returned opaque index: %v (%s)", err, stderr)
	}
	secondHeader, _, ok := strings.Cut(second, "\n")
	if !ok {
		t.Fatalf("second scan output has no frame separator: %q", second)
	}
	if err := json.Unmarshal([]byte(secondHeader), &metadata); err != nil {
		t.Fatal(err)
	}
	if len(metadata.IDs) != 0 {
		t.Fatalf("unchanged store reports changed addresses: %v", metadata.IDs)
	}
}
