package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDevSourcePathRoundtrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// Without a marker, devSourcePath should fail.
	if _, err := devSourcePath(); err == nil {
		t.Fatal("expected error without dev-source marker, got nil")
	}

	// Write a go.mod so devSourcePath accepts the path.
	srcDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(srcDir, "go.mod"), []byte("module test"), 0644); err != nil {
		t.Fatalf("write go.mod: %v", err)
	}

	// Write the dev-source marker directly (the former setDevSource writer).
	marker := devSourceMarker()
	if err := os.MkdirAll(filepath.Dir(marker), 0755); err != nil {
		t.Fatalf("mkdir marker dir: %v", err)
	}
	if err := os.WriteFile(marker, []byte(srcDir+"\n"), 0644); err != nil {
		t.Fatalf("write dev-source marker: %v", err)
	}

	got, err := devSourcePath()
	if err != nil {
		t.Fatalf("devSourcePath: %v", err)
	}
	if got != srcDir {
		t.Fatalf("expected %s, got %s", srcDir, got)
	}
}
