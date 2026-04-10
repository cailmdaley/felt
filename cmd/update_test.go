package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectBundledSkillInstall(t *testing.T) {
	tmp := t.TempDir()

	present, linked, err := detectBundledSkillInstall(tmp)
	if err != nil {
		t.Fatalf("detectBundledSkillInstall(empty): %v", err)
	}
	if present || linked {
		t.Fatalf("empty target should not look installed, got present=%v linked=%v", present, linked)
	}

	skillDir := filepath.Join(tmp, "felt")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatalf("mkdir felt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("old"), 0644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}

	present, linked, err = detectBundledSkillInstall(tmp)
	if err != nil {
		t.Fatalf("detectBundledSkillInstall(copied): %v", err)
	}
	if !present || linked {
		t.Fatalf("copied install should be present and not linked, got present=%v linked=%v", present, linked)
	}
}

func TestRefreshInstalledSkillsUpdatesCopiedSkills(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	target := filepath.Join(home, ".agents", "skills")
	skillRoot := filepath.Join(target, "felt")
	stalePath := filepath.Join(target, "felt", "scripts", "ralph")
	if err := os.MkdirAll(filepath.Dir(stalePath), 0755); err != nil {
		t.Fatalf("mkdir stale path: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillRoot, "SKILL.md"), []byte("stale skill"), 0644); err != nil {
		t.Fatalf("write stale SKILL.md: %v", err)
	}
	if err := os.WriteFile(stalePath, []byte("stale ralph"), 0755); err != nil {
		t.Fatalf("write stale script: %v", err)
	}

	refreshInstalledSkills()

	updated, err := os.ReadFile(stalePath)
	if err != nil {
		t.Fatalf("read updated script: %v", err)
	}
	text := string(updated)
	if !strings.Contains(text, "Activate the ralph skill ($ralph)") {
		t.Fatalf("expected updated codex-safe ralph prompt, got: %s", text)
	}
	if !strings.Contains(text, "bash-loop handoff back to the parent ralph launcher") {
		t.Fatalf("expected explicit non-destructive handoff wording, got: %s", text)
	}
}
