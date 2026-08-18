package cmd

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestCheckCommandReportsIssues(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	fiber := &felt.Felt{ID: "fiber-a"}
	if err := fiber.SetExtraField("inputs", []map[string]any{{"id": "catalog", "from": "missing.output"}}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatal("felt check succeeded unexpectedly")
	}
	if !strings.Contains(output, "broken data-flow reference") {
		t.Fatalf("missing lint output:\n%s", output)
	}
}

func TestCheckCommandSucceedsWhenOnlySubstrateChecksPass(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	fiber := &felt.Felt{ID: "fiber-a", Name: "Fiber A", CreatedAt: mustParseTime(t, "2026-04-10T09:00:00Z")}
	if err := fiber.SetExtraField("decisions", map[string]any{
		"choice": map[string]any{"label": "Choice"},
	}); err != nil {
		t.Fatalf("SetExtraField: %v", err)
	}
	if err := storage.Write(fiber); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err != nil {
		t.Fatalf("felt check returned error unexpectedly: %v\n%s", err, output)
	}
	if !strings.Contains(output, "Check OK") {
		t.Fatalf("missing success summary:\n%s", output)
	}
}

func TestCheckCommandReportsLegacyFormatIssues(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	path := filepath.Join(dir, ".felt", "legacy-fiber", "legacy-fiber.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir legacy fiber: %v", err)
	}
	content := `---
title: Legacy Fiber
depends-on:
  - upstream
created-at: 2026-04-10T10:00:00Z
---

(legacy-fiber)=

Body.
`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write legacy fiber: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatal("felt check succeeded unexpectedly")
	}
	if !strings.Contains(output, `legacy frontmatter key "title" should be renamed to "name"`) {
		t.Fatalf("missing legacy title lint output:\n%s", output)
	}
	if !strings.Contains(output, `legacy frontmatter key "depends-on" should be removed`) {
		t.Fatalf("missing legacy depends-on lint output:\n%s", output)
	}
	if !strings.Contains(output, "legacy MyST anchor should be removed") {
		t.Fatalf("missing legacy anchor lint output:\n%s", output)
	}
}

func runCommand(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()

	oldArgs := os.Args
	oldChangeDir := changeDir
	oldStdout := os.Stdout
	defer func() {
		os.Args = oldArgs
		changeDir = oldChangeDir
		os.Stdout = oldStdout
	}()

	changeDir = dir
	rootCmd.SetArgs(args)

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stdout = w

	runErr := rootCmd.Execute()

	if err := w.Close(); err != nil {
		t.Fatalf("close write pipe: %v", err)
	}
	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatalf("read command output: %v", err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("close read pipe: %v", err)
	}

	rootCmd.SetArgs(nil)
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(io.Discard)
	os.Args = []string{filepath.Base(oldArgs[0])}

	return buf.String(), runErr
}

// TestCheckCommandCountsUnparseableFiberFirst pins the fix for a store where a
// fiber had been invisible for three weeks. Its `outcome:` was a bare unquoted
// scalar containing a colon-space, which YAML reads as a nested mapping; the
// file stopped parsing, the listing walk skipped it with a stderr warning, and
// `felt check` — the command whose whole job is finding problems — did not
// count it. A fiber can drop out of the assemblage entirely; check must say so,
// first, and fail.
func TestCheckCommandCountsUnparseableFiberFirst(t *testing.T) {
	dir := t.TempDir()
	storage := felt.NewStorage(dir)
	if err := storage.Init(); err != nil {
		t.Fatalf("Init() error: %v", err)
	}

	// A second, lesser problem: a broken body reference. It must still be
	// reported — and must come after the fiber that no longer exists.
	linker := &felt.Felt{ID: "linker", Name: "Linker", Body: "See [[nowhere]]."}
	if err := storage.Write(linker); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	brokenPath := filepath.Join(dir, ".felt", "venue", "venue.md")
	if err := os.MkdirAll(filepath.Dir(brokenPath), 0755); err != nil {
		t.Fatalf("mkdir venue: %v", err)
	}
	broken := `---
name: Venue
created-at: 2026-04-10T10:00:00Z
outcome: booked 8/1: deposit paid
---

Body.
`
	if err := os.WriteFile(brokenPath, []byte(broken), 0644); err != nil {
		t.Fatalf("write venue fiber: %v", err)
	}

	// The fiber really is invisible to the rest of felt — the premise of the
	// whole check.
	felts, err := storage.List()
	if err != nil {
		t.Fatalf("List() error: %v", err)
	}
	for _, f := range felts {
		if f.ID == "venue" {
			t.Fatal("expected the malformed fiber to be absent from List()")
		}
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatalf("felt check succeeded despite an unparseable fiber:\n%s", output)
	}
	if !strings.Contains(err.Error(), "2 error(s)") {
		t.Fatalf("unparseable fiber not counted as an error: %v\n%s", err, output)
	}

	unparseable := strings.Index(output, "unparseable")
	if unparseable < 0 {
		t.Fatalf("check does not report the unparseable fiber:\n%s", output)
	}
	// The walk resolves symlinks (macOS /var → /private/var).
	resolvedPath, err := filepath.EvalSymlinks(brokenPath)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	if !strings.Contains(output, resolvedPath) {
		t.Fatalf("check does not name the unparseable fiber's path:\n%s", output)
	}
	if !strings.Contains(output, "mapping values are not allowed") {
		t.Fatalf("check does not carry the parse error:\n%s", output)
	}
	if broken := strings.Index(output, "broken body reference"); broken < 0 || broken < unparseable {
		t.Fatalf("unparseable fiber must be reported before cosmetic issues:\n%s", output)
	}
}
