package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

// TestInstallSkills_HealsBrokenSymlink verifies that a top-level skill entry
// which is a symlink to a missing path (left over from an older
// `felt setup skills --link <path>` whose source moved) gets removed so
// installation can proceed. Without this, MkdirAll through the broken
// symlink fails with "file exists" and the bundled skill never gets written.
func TestInstallSkills_HealsBrokenSymlink(t *testing.T) {
	target := t.TempDir()

	// Plant a broken symlink at the spot where the "felt" skill would install.
	broken := filepath.Join(target, "felt")
	if err := os.Symlink(filepath.Join(target, "does-not-exist"), broken); err != nil {
		t.Fatalf("setup: symlink: %v", err)
	}

	if err := installSkills(target, false); err != nil {
		t.Fatalf("installSkills: %v", err)
	}

	// After install, the "felt" entry should resolve and contain SKILL.md.
	info, err := os.Stat(filepath.Join(target, "felt", "SKILL.md"))
	if err != nil {
		t.Fatalf("expected bundled felt/SKILL.md after heal, got: %v", err)
	}
	if info.IsDir() {
		t.Fatalf("expected SKILL.md to be a file, got directory")
	}
}

// TestInstallSkills_PreservesIntactSymlink verifies that a top-level skill
// symlink whose target *does* resolve — the `felt setup skills --link`
// dev-mode workflow — is left untouched, so edits to the linked source
// keep flowing through.
func TestInstallSkills_PreservesIntactSymlink(t *testing.T) {
	target := t.TempDir()
	linkSrc := t.TempDir()

	// Live symlink: felt -> linkSrc (which exists).
	if err := os.Symlink(linkSrc, filepath.Join(target, "felt")); err != nil {
		t.Fatalf("setup: symlink: %v", err)
	}

	if err := installSkills(target, false); err != nil {
		t.Fatalf("installSkills: %v", err)
	}

	// The symlink should still be a symlink pointing at linkSrc.
	info, err := os.Lstat(filepath.Join(target, "felt"))
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected felt to still be a symlink, got mode %v", info.Mode())
	}
	resolved, err := os.Readlink(filepath.Join(target, "felt"))
	if err != nil {
		t.Fatalf("readlink: %v", err)
	}
	if resolved != linkSrc {
		t.Fatalf("expected symlink target %s, got %s", linkSrc, resolved)
	}
}
