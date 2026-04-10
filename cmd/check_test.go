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

	if err := storage.Write(&felt.Felt{
		ID: "fiber-a",
		Decisions: map[string]felt.ASTRADecision{
			"choice": {Label: "Choice"},
		},
	}); err != nil {
		t.Fatalf("Write() error: %v", err)
	}

	output, err := runCommand(t, dir, "check")
	if err == nil {
		t.Fatal("felt check succeeded unexpectedly")
	}
	if !strings.Contains(output, "decision has no options") {
		t.Fatalf("missing lint output:\n%s", output)
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

	// Cobra state can leak across invocations when tests reuse the singleton.
	rootCmd.SetArgs(nil)
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(io.Discard)
	os.Args = []string{filepath.Base(oldArgs[0])}

	return buf.String(), runErr
}
