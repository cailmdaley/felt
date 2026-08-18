package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestInitCommandNamesWhatItCreated pins the fresh-init output. "Ensured
// .felt/ support files" — the phrasing this replaced — is idempotency-check
// vocabulary: at the one moment where confirmation matters most, it read as
// though nothing much had happened, and it named neither the path nor a next
// step.
func TestInitCommandNamesWhatItCreated(t *testing.T) {
	dir := t.TempDir()

	output, err := runCommand(t, dir, "init")
	if err != nil {
		t.Fatalf("felt init returned error unexpectedly: %v\n%s", err, output)
	}

	root, err := filepath.Abs(filepath.Join(dir, ".felt"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if !strings.Contains(output, "Created felt store at "+root) {
		t.Fatalf("init output does not name the absolute store path:\n%s", output)
	}
	if !strings.Contains(output, ".gitignore") {
		t.Fatalf("init output does not name the support file it wrote:\n%s", output)
	}
	if !strings.Contains(output, "felt add") || !strings.Contains(output, "felt ls") {
		t.Fatalf("init output offers no next step:\n%s", output)
	}

	// -C is honored: the store lands where the flag points, not in the
	// process's cwd (runCommand sets changeDir, never chdir's).
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Fatalf("expected .felt/ at %s: %v", root, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".gitignore")); err != nil {
		t.Fatalf("expected .gitignore in the new store: %v", err)
	}
}

// TestInitCommandOverExistingStoreStaysIdempotent keeps the "nothing much
// happened" register where it belongs — the re-run, not the first run.
func TestInitCommandOverExistingStoreStaysIdempotent(t *testing.T) {
	dir := t.TempDir()

	if _, err := runCommand(t, dir, "init"); err != nil {
		t.Fatalf("first init: %v", err)
	}
	output, err := runCommand(t, dir, "init")
	if err != nil {
		t.Fatalf("second init returned error unexpectedly: %v\n%s", err, output)
	}
	if strings.Contains(output, "Created felt store") {
		t.Fatalf("second init claims to have created the store:\n%s", output)
	}
	if !strings.Contains(output, "already present") {
		t.Fatalf("second init does not report the store as pre-existing:\n%s", output)
	}
}
