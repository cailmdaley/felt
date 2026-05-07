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
